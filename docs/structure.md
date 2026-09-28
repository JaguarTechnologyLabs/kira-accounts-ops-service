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

### 1.2 La Comunicación entre Outbox y Webhook (El Viaje de Ida y Vuelta)

El dinero y los mensajes realizan un viaje desacoplado en dos direcciones independientes (ida asíncrona y vuelta asíncrona):

```text
[ Cliente ] 
     │  (1. Petición POST /transfers)
     ▼
[ API ] ──► Guarda transfer 'created' + 'hold' contable + tarea 'pending' en outbox
     │
     ▼
[ Worker ] ──► (2. Lee outbox y envía al banco) ──► [ Banco / Provider ]
                                                          │
                                                          │ (3. Notificación asíncrona: POST /webhooks/provider)
                                                          ▼
[ applyProviderResult ] ◄── (4. Deduplica evento y busca por provider_ref) ◄── [ Webhook Handler ]
     │
     └──► Asienta movimiento definitivo en Ledger y estado final ('settled', 'reversed', etc.)
```

#### FASE 1: IDA (Kira hacia el Banco / Outbox)
1. **Petición del Cliente (`POST /transfers`):**
   * **Archivo:** `src/app.ts` (`app.post('/transfers')`)
   * El cliente solicita la transferencia enviando monto, riel y clave de idempotencia.
2. **Creación Local, Reserva Contable y Encolado en Outbox:**
   * **Archivos:** `src/transfers.ts` (`createOutboundTransfer`) y `src/ledger.ts` (`post`)
   * Se inserta el registro en la tabla `transfers` con `status = 'created'`, se inserta la reserva preventiva (`hold`) en `ledger_entries`, y se inserta la tarea en la tabla `outbox` con `status = 'pending'`. La API responde de inmediato al cliente.
3. **Lectura y Despacho del Worker:**
   * **Archivo:** `src/outbox.ts` (`processOutbox`)
   * El worker en segundo plano consulta los eventos con `status = 'pending'` en la tabla `outbox` de PostgreSQL.
4. **Llamada a la API del Proveedor Externo:**
   * **Archivo:** `src/providers.ts` (`provider.submit`)
   * El worker invoca la función de envío. El proveedor acepta el pago y genera un comprobante único de operación: `provider_ref` (ej. `PROV-0001`).
5. **Confirmación de Envío en Base de Datos:**
   * **Archivos:** `src/transfers.ts` (`setStatus`) y `src/outbox.ts` (`processOutbox`)
   * Se asocia el `provider_ref` a la transferencia y se actualiza su estado a `submitted`. Se marca la fila del outbox como `status = 'processed'`.
   * **Aquí concluye el trabajo del Outbox:** la orden ya fue entregada con éxito a los rieles del proveedor.

#### FASE 2: VUELTA (El Banco hacia Kira / Webhooks)
6. **Notificación Asíncrona del Proveedor (`POST /webhooks/provider`):**
   * **Archivo:** `src/app.ts` (`app.post('/webhooks/provider')`)
   * Horas o días después, cuando el banco liquida (`settled`), rechaza (`failed`) o reversa (`reversed`) el dinero, envía una notificación HTTP webhook con `provider_ref`, `status` y `provider_event_id`.
7. **Recepción, Deduplicación y Búsqueda de la Transferencia:**
   * **Archivo:** `src/webhooks.ts` (`handleWebhook`)
   * Se verifica en la tabla `processed_events` que no hayamos procesado ese `provider_event_id` antes (idempotencia de webhooks). Luego busca la transferencia en la base de datos haciendo: `SELECT * FROM transfers WHERE provider_ref = $1`.
8. **Asiento Contable Definitivo y Transición a Estado Terminal:**
   * **Archivos:** `src/transfers.ts` (`applyProviderResult`) y `src/ledger.ts` (`post`)
   * Si es `settled`: registra `debit` y `release` (el dinero sale definitivamente y se quita el hold).
   * Si es `failed`, `returned` o `reversed`: registra solo `release` (se descongela el hold y el dinero regresa al saldo disponible del cliente).
   * Se actualiza el estado de la transferencia a su estado terminal definitivo (`settled`, `failed`, `reversed`, etc.).

### 1.3 El Flujo de Retorno y Descongelación de Dinero (Reversiones y Fallos - Caso TICKET-202)

Cuando una transferencia no puede completarse en el proveedor (por ejemplo, rechazo en la red blockchain, cuenta bancaria cerrada o reversión), el dinero nunca sale de Kira y debe ser liberado de vuelta a la cuenta del cliente:

```text
[ Proveedor Externo ]
       │  (1. Notifica fallo o reversión: status = 'reversed' | 'failed' | 'returned')
       ▼
[ POST /webhooks/provider ] (src/app.ts)
       │
       ▼
[ handleWebhook ] (src/webhooks.ts)
       │  (2. Deduplica por provider_event_id y busca transfer por provider_ref)
       ▼
[ applyProviderResult ] (src/transfers.ts)
       │
       ├──► 3. Asiento contable de liberación (src/ledger.ts):
       │       entry_type: 'release', amount: (monto + comisión)
       │       [Cancela el 'hold' previo; el saldo disponible aumenta de inmediato]
       │
       └──► 4. Transición de estado (src/transfers.ts):
               status pasa de 'submitted' -> 'reversed' (estado terminal)
```

#### Anatomía Contable de una Reversión (Ejemplo con Números)
Supongamos que el cliente tiene **$1,000.00** (`100,000` centavos) e intenta enviar **$600.00** (más comisión de **$17.40** = Total **$617.40**):

1. **Momento 1: Creación del pago (`POST /transfers`)**
   * *Archivo:* `src/transfers.ts` y `src/ledger.ts`
   * Se inserta un `hold` de -$617.40 en `ledger_entries`.
   * **Saldo disponible:** `$1,000.00 - $617.40 = $382.60`.
   * El cliente tiene $617.40 congelados preventivamente.
2. **Momento 2: El proveedor reversa el pago**
   * *Archivo:* `src/providers.ts`
   * El banco o red cripto cancela la transacción y envía el webhook con `status: 'reversed'`.
3. **Momento 3: Liberación de fondos (`applyProviderResult`)**
   * *Archivo:* `src/transfers.ts` y `src/ledger.ts`
   * En `applyProviderResult` se inserta un `release` de +$617.40 en `ledger_entries`.
   * **¡No se inserta ningún `debit`!** (El dinero físico nunca salió de las cuentas de Kira hacia el destinatario).
4. **Momento 4: Cálculo del nuevo saldo disponible**
   * *Archivo:* `src/ledger.ts` (`availableCents`)
   $$\text{Saldo} = \underbrace{+100,000}_{\text{credit inicial}} \underbrace{- 61,740}_{\text{hold inicial}} \underbrace{+ 61,740}_{\text{release de reversión}} = 100,000 \text{ ($1,000.00 USD)}$$
   * El `hold` y el `release` se anulan mutuamente (`-61,740 + 61,740 = 0`).
   * El saldo disponible vuelve a ser de **$1,000.00 USD** intacto.
   * La transferencia queda asentada para auditoría en estado terminal **`reversed`**.

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

---

## 4. La Máquina de Estados de una Transferencia

Toda transferencia sigue un ciclo de vida unidireccional y predecible:

```text
               ┌──────────────┐
               │   created    │ ◄─── POST /transfers (Hold en Ledger)
               └──────┬───────┘
                      │
                      ▼ Worker despacha al proveedor
               ┌──────────────┐
               │  submitted   │ (Hold sigue activo, esperando respuesta)
               └──────┬───────┘
                      │
         ┌────────────┼────────────┬─────────────┬─────────────┐
         ▼            ▼            ▼             ▼             ▼
   ┌───────────┐ ┌─────────┐ ┌───────────┐ ┌───────────┐ ┌────────────┐
   │  pending  │ │ settled │ │  failed   │ │ returned  │ │  reversed  │
   └─────┬─────┘ └─────────┘ └───────────┘ └───────────┘ └────────────┘
         │            ▲
         └────────────┘
```

### Reglas de la Máquina de Estados:
1. **Estados No Terminales (Transitorios):** `created`, `submitted`, `pending`.
   * La operación está en vuelo. Los fondos continúan congelados en el ledger mediante el `hold`.
2. **Estados Terminales (Definitivos):** `settled`, `failed`, `returned`, `reversed`.
   * **Inmutabilidad de estado final:** Una vez que una transferencia alcanza un estado terminal, **NUNCA** debe ser modificada por webhooks posteriores o desordenados (protección vital para TICKET-203).

---

## 5. Matriz de Estados de Transferencias y Movimientos del Ledger

| Estado en `transfers` | ¿Es Terminal? | Asientos en `ledger_entries` | Impacto en Saldo Disponible | Significado en el Negocio |
| :--- | :---: | :--- | :--- | :--- |
| **`created`** | ❌ No | `hold` (- total) | **Disminuye** (`- amount - fee`) | La API recibió la orden del cliente y congeló el dinero preventivamente. Aún no se envía al banco. |
| **`submitted`** | ❌ No | *(Ninguno nuevo, el hold sigue)* | **Sin cambios** (sigue congelado) | El worker despachó la orden al banco. El banco confirmó recepción (`provider_ref`). Esperando desenlace. |
| **`pending`** | ❌ No | *(Ninguno nuevo, el hold sigue)* | **Sin cambios** (sigue congelado) | El banco notificó que el dinero está en tránsito o en compensación interna (ej. ACH). |
| **`settled`** |  **Sí** | `debit` (- total) + `release` (+ total) | **Débito definitivo** (`hold` y `release` se cancelan; queda el `debit`) | **Éxito total.** El proveedor confirmó que el destinatario ya recibió el dinero. Salida definitiva de fondos. |
| **`failed`** |  **Sí** | `release` (+ total) | **Se restaura al 100%** (`release` cancela el `hold`) | El banco rechazó la orden de inmediato (cuenta inexistente, etc.). El dinero se descongela al cliente. |
| **`returned`** |  **Sí** | `release` (+ total) | **Se restaura al 100%** (`release` cancela el `hold`) | El banco destino devolvió el dinero horas después (devolución ACH). Los fondos se descongelan. |
| **`reversed`** *(Ticket 202)* |  **Sí** | `release` (+ total) | **Se restaura al 100%** (`release` cancela el `hold`) | El proveedor canceló o reversó la transacción (ej. reversión de red cripto). Fondos descongelados. |

### Tipos de Movimientos Contables en `ledger_entries`:
* **`credit` (+):** Entrada de dinero nuevo a la cuenta (fondeo inicial). Suma saldo disponible.
* **`debit` (-):** Salida real y definitiva de dinero transferido a un tercero. Resta saldo disponible.
* **`hold` (-):** Bloqueo preventivo de dinero mientras la transferencia viaja por el banco. Resta saldo disponible.
* **`release` (+):** Desbloqueo de una retención previa. Cancela el `hold`.

$$\text{Saldo Disponible} = \sum(\text{credit}) + \sum(\text{release}) - \sum(\text{debit}) - \sum(\text{hold})$$

---

## 6. Proceso Detallado: `processOutbox` ➔ `handleWebhook` ➔ `applyProviderResult`

Este es el pipeline que conecta la salida de órdenes con la entrada de confirmaciones:

```text
┌────────────────────────────────────────────────────────────────────────┐
│ 1. processOutbox (src/outbox.ts)                                       │
│    - Busca tareas con status='pending' en la tabla 'outbox'.          │
│    - Consulta la transferencia asociada (getTransfer).                 │
│    - Invoca a provider.submit(transfer).                              │
│    - Guarda provider_ref y actualiza estado a 'submitted'.             │
│    - Marca la tarea del outbox como 'processed'.                       │
│    - Despacha los webhooks devueltos por el sandbox.                   │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. handleWebhook (src/webhooks.ts)                                     │
│    - Recibe el payload del proveedor (provider_event_id, provider_ref).│
│    - Deduplica contra la tabla 'processed_events'.                     │
│    - Si ya fue procesado, descarta con { status: 'skipped' }.          │
│    - Busca la transferencia en Postgres: SELECT WHERE provider_ref=$1. │
│    - Si existe, delega el procesamiento contable a applyProviderResult.│
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. applyProviderResult (src/transfers.ts)                              │
│    - Evalúa el status del webhook ('settled', 'failed', 'reversed').   │
│    - Si es 'settled': post(debit) + post(release) y estado='settled'.  │
│    - Si es 'reversed'/'failed': post(release) y estado terminal.       │
│    - Registra el log de trazabilidad con correlation_id.               │
└────────────────────────────────────────────────────────────────────────┘
```

