# Arquitectura y Estructura del Sistema (Kira Accounts Ops Service)

Este documento detalla la arquitectura, el flujo del dinero, los modelos contables y la responsabilidad de cada módulo del servicio de cuentas y pagos.

---

## 1. Visión General y Flujo del Dinero (*How Money Moves*)

El servicio implementa un backend de cuentas virtuales y movimientos de dinero internacionales (cross-border) sobre rieles ACH y Cripto.

```text
[ Cliente ] 
     │
     │ 1. POST /transfers (con Idempotency-Key)
     ▼
[ API / transfers.ts ] ──► Registra transferencia en estado 'created'
     │                 ──► Ledger: emite un 'hold' (reserva saldo)
     │                 ──► Outbox: encola evento 'transfer.submit'
     ▼
[ Worker / outbox.ts ] ──► Lee evento pendiente de la tabla outbox
     │                 ──► Envía a la API del Proveedor (providers.ts)
     │                 ──► Guarda provider_ref y actualiza estado a 'submitted'
     ▼
[ Proveedor Externo ]  ──► Procesa en rieles externos
     │
     │ 2. Webhook asíncrono (webhooks.ts)
     ▼
[ applyProviderResult ] ──► Deduplica por provider_event_id
                        ──► Actualiza estado final ('settled', 'failed', 'reversed', etc.)
                        ──► Ledger: asienta movimientos contables definitivos
```

---

## 2. Cada Módulo del Repositorio y su Responsabilidad

### A. Base de Datos y Persistencia
* **`src/db.ts`**
  * Utiliza **PGlite** (`@electric-sql/pglite`), un motor PostgreSQL real compilado a WebAssembly que se ejecuta en memoria dentro del proceso Node.js (cero dependencias externas como Docker).
  * **Esquema relacional:**
    * `accounts`: Cuentas virtuales de clientes (ej. `ACC-MAREA`, Marea Pay S.A.).
    * `transfers`: Registros de transferencias salientes y entrantes con sus estados (`created`, `submitted`, `pending`, `settled`, `failed`, `returned`), riel (`ach` o `crypto`), montos, tarifas y claves de idempotencia.
    * `ledger_entries`: Libro mayor contable inmutable (asientos de `credit`, `debit`, `hold`, `release`).
    * `outbox`: Tabla de mensajería transaccional para el Outbox Pattern (`transfer.submit`, `attempts`, `status`).
    * `processed_events`: Registro de deduplicación de webhooks (`provider_event_id`).

---

### B. El Libro Contable (*The Ledger*)
* **`src/ledger.ts`**
  * `post()`: Inserta un registro inmutable en `ledger_entries`. Nunca se edita ni se borra ninguna fila.
  * `availableCents()`: Calcula el saldo disponible en tiempo real sumando y restando entradas contables:
    ```sql
    select coalesce(sum(case entry_type
        when 'credit'  then  amount_cents   -- (+) Dinero que entra a la cuenta
        when 'release' then  amount_cents   -- (+) Desbloqueo de una retención previa
        when 'debit'   then -amount_cents   -- (-) Dinero que sale definitivamente
        when 'hold'    then -amount_cents   -- (-) Dinero bloqueado preventivamente
        else 0 end), 0)::bigint as bal
    from ledger_entries where account_id = $1
    ```
  * **Lógica Contable:**
    * **Depósito inicial ($100.00):** Entra un `credit` de +$100. Saldo disponible = $100.
    * **Solicitud de salida ($40.00):** Se emite un `hold` de -$40. Saldo disponible = $60 (esos $40 quedan bloqueados para evitar doble gasto).
    * **Pago liquidado (`settled`):** Se emite un `debit` de -$40 y un `release` de +$40.
      $$\text{Saldo} = +100 - 40 (\text{hold}) + 40 (\text{release}) - 40 (\text{debit}) = 60$$
      El `hold` y el `release` se cancelan mutuamente a 0, quedando solo el débito real.
    * **Pago fallido (`failed`):** Solo se emite un `release` de +$40.
      $$\text{Saldo} = +100 - 40 (\text{hold}) + 40 (\text{release}) = 100$$
      El `release` cancela el `hold` y el cliente recupera su saldo disponible.

---

### C. Dominio de Transferencias
* **`src/transfers.ts`**
  * `createOutboundTransfer()`: Orquesta la creación de pagos salientes:
    1. Verifica si ya existe una transferencia con ese `idempotency_key`.
    2. Inserta la fila en `transfers` en estado `created`.
    3. Emite el `hold` contable en el ledger por `amount + fee`.
    4. Encola el evento `transfer.submit` en la tabla `outbox`.
  * `creditInbound()`: Asienta ingresos de fondos hacia las cuentas.
  * `setStatus()`: Actualiza el estado de la transferencia y asigna el `provider_ref`.
  * `applyProviderResult()`: Máquina de estados que procesa el desenlace reportado por el proveedor y aplica los movimientos en el ledger.

---

### D. Despacho Asíncrono (*Outbox Pattern*)
* **`src/outbox.ts`**
  * `processOutbox()`: Es el **Worker**.
  * Consulta las tareas con `status='pending'` en la tabla `outbox`.
  * Llama a `provider.submit()`. Si tiene éxito, marca el outbox como `processed` y actualiza la transferencia a `submitted` con su `provider_ref`.
  * Si el proveedor lanza un error (ej. timeout de red), incrementa `attempts` y deja la tarea pendiente para un próximo reintento (hasta 3 intentos).

---

### E. El Proveedor Mock (*Payment Rail Sandbox*)
* **`src/providers.ts`**
  * Simula un banco o red blockchain externa en modo sandbox.
  * Soporta escenarios programados en la transferencia mediante el campo `scenario`:
    * `ok`: Flujo ideal de procesamiento exitoso.
    * `reversed`: El proveedor acepta el pago pero luego envía un webhook de reversión.
    * `out_of_order`: El proveedor envía primero el evento `settled` y después un evento `failed` (desorden en la red).
    * `timeout_once`: El proveedor recibe y acepta el dinero, pero la conexión HTTP se corta antes de responder a Kira (lanzando `ProviderTimeout`).
  * `statement()`: Genera el extracto bancario con las transacciones liquidadas y las tarifas calculadas.

---

### F. Recepción de Webhooks
* **`src/webhooks.ts`**
  * `handleWebhook()`: Valida que el `provider_event_id` no haya sido procesado antes en `processed_events`.
  * Si es nuevo, busca la transferencia asociada por `provider_ref` y delega a `applyProviderResult()`.

---

### G. Reconciliación Bancaria
* **`src/reconciliation.ts`**
  * `reconcile()`: Cruza dos fuentes de verdad:
    1. Lo que nuestro sistema cree que se liquidó (`transfers where status = 'settled'`).
    2. Lo que el extracto del proveedor dice que realmente cobró (`provider.statement()`).
  * Calcula la diferencia neta (`diffCents`) y lista discrepancias de comisiones o transferencias no cruzadas (`statementOnly`, `ledgerOnly`).

---

### H. Exposición HTTP y Semilla
* **`src/app.ts`**: API Express con endpoints REST:
  * `POST /transfers`: Creación de transferencias.
  * `GET /transfers/:id`: Consulta de estado de transferencia.
  * `GET /accounts/:id/balance`: Consulta de saldo disponible.
  * `POST /webhooks/provider`: Entrada de webhooks.
  * `POST /worker/run`: Disparo manual del worker de outbox.
  * `GET /outbox`: Inspección de la cola de outbox.
  * `GET /provider/submissions`: Inspección de cobros reales en el sandbox.
  * `GET /reconciliation`: Reporte de conciliación.
* **`src/bootstrap.ts`** & **`src/demo.ts`**:
  * Crean una base de datos fresca en memoria y ejecutan las secuencias exactas que reprodujeron los 6 incidentes de producción para que sean 100% reproducibles.
* **`src/money.ts`**:
  * Utilidades para montos y cálculo de comisión de plataforma (2.9%).
* **`src/faults.ts`**:
  * Hook de inyección de caos para simular caídas de proceso (`crashMidRequestFor`).
