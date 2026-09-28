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

### 1.1 La historia de un pago en la vida real
Ponte en los zapatos de la operación cotidiana:

1. **El depósito inicial (Fondeo):** Marea Pay abre su cuenta en Kira y deposita $20,000 USD para operar su negocio ese mes.
2. **La orden de pago:** El lunes por la mañana, Marea Pay entra a su sistema y dice: *"Por favor, transfieran $500.00 USD al proveedor Juan Pérez en EE.UU."*.
3. **El cobro del servicio (Comisión):** Kira le dice: *"Perfecto. Son $500.00 del pago + $14.50 de comisión por el servicio (el 2.9%) = Total $514.50"*.
4. **La congelación preventiva (El dilema de la confianza):** Kira todavía no le ha entregado los $500 al proveedor (la red bancaria tarda horas en procesarlo). Pero Kira tampoco puede dejar esos $514.50 libres en la cuenta de Marea Pay, porque si Marea Pay ve que aún tiene los $20,000 completos, podría gastárselos en otra cosa. Entonces, Kira bloquea preventivamente esos $514.50. El saldo disponible de Marea Pay baja a $19,485.50.
5. **El envío al banco intermediario:** Kira le pasa la instrucción a su banco aliado en EE.UU. para que envíe el dinero a la cuenta de Juan Pérez.
6. **El desenlace:**
   * **Escenario A (Éxito):** El banco avisa: *"Listo, el dinero ya está en la cuenta de Juan Pérez"*. Kira descuenta definitivamente los $514.50 de Marea Pay y Kira se embolsa sus $14.50 de ganancia.
   * **Escenario B (Rechazo):** El banco avisa: *"Rechazado, el número de cuenta de Juan Pérez no existe"*. Kira descongela los $514.50 y se los devuelve intactos a Marea Pay.
7. **El cierre del día (Conciliación):** A las 6:00 PM, el departamento de Finanzas de Kira descarga el extracto del banco y lo compara con el sistema. Cada dólar que salió de la cuenta bancaria de Kira tiene que coincidir exactamente con una orden autorizada de un cliente. Si falta o sobra un solo centavo, hay un problema grave de auditoría.

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
* **`src/app.ts`**: API Express con endpoints REST (`POST /transfers`, `GET /accounts/:id/balance`, `POST /webhooks/provider`, `POST /worker/run`, `GET /reconciliation`).
* **`src/bootstrap.ts`** & **`src/demo.ts`**:
  * Crean una base de datos fresca en memoria y ejecutan las secuencias exactas que reprodujeron los 6 incidentes de producción para que sean 100% reproducibles.
* **`src/money.ts`**:
  * Utilidades para montos y cálculo de comisión de plataforma (2.9%).
* **`src/faults.ts`**:
  * Hook de inyección de caos para simular caídas de proceso (`crashMidRequestFor`).

---

## 3. Cómo la Tecnología Resuelve Cada Regla de Negocio

Todo lo que ves en las carpetas y archivos del repositorio existe para soportar la operación real:

| Problema de Negocio | ¿Por qué es un riesgo? | ¿Cómo lo resuelve el código? | Archivo relevante |
| :--- | :--- | :--- | :--- |
| **"No editar saldos a mano"** | Si un empleado o un bug edita `balance = balance - 50`, no hay rastro legal de qué pasó con el dinero. | **Ledger de partida doble:** El saldo nunca se actualiza; se calcula sumando entradas históricas inmutables (`credit`, `debit`, `hold`, `release`). | `src/ledger.ts` |
| **"El cliente hace doble clic por error"** | Si el cliente tiene mal internet y envía dos veces la misma orden, no podemos pagarle dos veces al proveedor. | **Idempotency Key:** Cada orden lleva un identificador único. Si llega dos veces el mismo identificador, el sistema responde con la orden existente sin crear una nueva. | `src/transfers.ts` |
| **"El servidor se cae o el banco tarda en responder"** | Si llamas al banco directo en la petición HTTP y el banco tarda 30 segundos o hay un corte de luz, la transacción se pierde o se queda en el limbo. | **Outbox Pattern:** La API guarda la intención en una tabla (`outbox`) y le responde de inmediato al cliente. Luego un proceso en segundo plano (el worker) toma esa fila y la envía al banco de forma segura y con reintentos. | `src/outbox.ts` |
| **"El banco avisa horas después"** | Los bancos no responden de inmediato; mandan notificaciones asíncronas por internet. | **Webhooks:** Un endpoint que recibe las notificaciones del banco (`settled`, `failed`, `reversed`), deduplica eventos repetidos y asienta el movimiento final en el ledger. | `src/webhooks.ts` |
| **"Auditoría de fin de día"** | Si Kira le cobra una tarifa al cliente pero el banco le cobra otra a Kira, Kira pierde dinero. | **Reconciliation Job:** Algoritmo que cruza automáticamente las transacciones del sistema contra el archivo CSV del extracto del banco. | `src/reconciliation.ts` |
