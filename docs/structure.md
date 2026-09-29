# Mis Notas de Arquitectura y Sistema (Kira Accounts Ops Service)

Mis notas personales para repasar cómo funciona este backend financiero, cómo se mueve la plata, qué hace cada archivo y cómo solucioné cada uno de los problemas del trial.

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
   ```text
   Saldo = +100,000 (credit inicial) - 61,740 (hold inicial) + 61,740 (release de reversión)
         = 100,000 centavos ($1,000.00 USD)
   ```
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
    * **Pago liquidado (`settled`):** Se emite un `debit` de -$40 y un `release` de +$40:
      `Saldo = +100 - 40 (hold) + 40 (release) - 40 (debit) = $60`
      El `hold` y el `release` se cancelan mutuamente a 0, quedando solo el débito real.
    * **Pago fallido (`failed`):** Solo se emite un `release` de +$40:
      `Saldo = +100 - 40 (hold) + 40 (release) = $100`
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

## 2.1 El Ecosistema de Datos: Las 5 Tablas Explicadas de Forma Natural

Para entender la base de datos sin enredarse en tecnicismos de SQL o diagramas rígidos, imagina que el sistema es una oficina financiera donde trabajan **5 departamentos o personas**, cada una con una libreta y una misión muy clara.

---

### Las 5 «Personas» de la Oficina (Las 5 Tablas)

#### 1. `accounts` ➔ La Carpeta de Identidad del Cliente
* **Quién es:** Es simplemente el archivador que dice quién es el cliente en el sistema (por ejemplo, Marea Pay S.A.) y en qué moneda opera (`USD`).
* **Dato importante y natural:** **Aquí NO existe un campo que diga "Saldo: $500"**. ¿Por qué? Porque en el mundo financiero real, el saldo de un cliente nunca se escribe a mano ni se edita a lápiz. Si alguien pudiera editar directamente el número de saldo, un error de tipeo o un bug podría regalar o desaparecer millones sin que nadie sepa qué pasó. El saldo vive en otra parte.

#### 2. `transfers` ➔ El Ticket de la Comanda (La Orden de Pago)
* **Quién es:** Es como el papelito de la comanda que toma un mesero en un restaurante cuando pides una comida: *"Marea Pay quiere enviar $500.00 USD al proveedor Juan Pérez en EE.UU. a través de la red ACH"*.
* **Qué anota este papelito:**
  * **El monto y la comisión:** $500.00 de envío + $14.50 de tarifa Kira = total $514.50.
  * **El estado actual:** Va cambiando a medida que avanza la orden (*"Recibida en ventanilla (`created`)"*, *"Enviada al banco (`submitted`)"*, *"Completada con éxito (`settled`)"*, o *"Rechazada (`failed`/`reversed`)"*).
  * **El sello anti-duplicados (`idempotency_key`):** Si el cliente le da doble clic al botón por error, el sistema mira este sello único y dice: *«Tranquilo, esa orden ya la tengo anotada aquí, es esta misma, no te voy a cobrar dos veces»*.
  * **El número de guía del banco (`provider_ref`):** Al principio está vacío. Cuando el banco acepta la orden, nos da un código de radicado (ej. `PROV-0001`) y lo anotamos aquí para poder rastrearlo después.

#### 3. `ledger_entries` ➔ La Libreta de Oro del Contador (El Libro Mayor)
* **Quién es:** Es el corazón del dinero. Es un libro contable donde solo se escribe con tinta que no se puede borrar ni tachar (**`append-only`**). Jamás se edita ni se borra una fila.
* **Cómo funciona en la vida real:**
  * Si el cliente deposita dinero, el contador anota: *`credit` +$1,000*.
  * Si el cliente pide enviar $500 (+ tarifa $14.50), el contador no le quita la plata todavía (porque el banco aún no la ha entregado), pero tampoco lo deja gastársela. Entonces anota un bloqueo preventivo: *`hold` -$514.50*.
  * Si el banco confirma que el dinero llegó al destinatario, el contador asienta: *`debit` -$514.50* (el dinero salió de verdad) y un *`release` +$514.50* (descongela el hold anterior porque ya se cobró).
  * Si el banco dice que el destinatario no existe o el pago se reversó, el contador solo anota: *`release` +$514.50* (descongela el dinero y se lo devuelve al cliente sin cobrarle nada).
* **¿Y cómo sabemos cuánta plata tiene el cliente?**
  `Saldo Disponible = (Plata que entró + Retenciones liberadas) - (Plata que salió + Retenciones activas)`

#### 4. `outbox` ➔ La Bandeja de Salida del Mensajero
* **Quién es:** Es la bandeja física donde se dejan las cartas pendientes que deben llevarse al banco.
* **Por qué existe (La analogía del cajero y el mensajero):**
  Si el cajero de la ventanilla tuviera que subirse en una moto e ir al banco cada vez que un cliente pide una transferencia, el cliente se quedaría parado 40 minutos en la ventanilla esperando. Y si la moto se pincha en el camino, la orden se pierde en el limbo.
  Por eso creamos el **Outbox**:
  1. El cajero recibe la orden, la anota en el sistema y mete un papelito en la bandeja `outbox` que dice: *"Por favor llevar la transferencia TX-0001 al banco"*. Al cliente le responde en medio segundo: *«Orden recibida con éxito»*.
  2. Luego, un mensajero independiente (el Worker en segundo plano) pasa periódicamente por la bandeja, toma las cartas pendientes, llama al banco, entrega la orden y anota cuántos intentos hizo si el banco estaba ocupado. Cuando el banco le recibe la orden, marca la carta como *"Despachada (`processed`)"*.

#### 5. `processed_events` ➔ La Lista de Cartas Ya Leídas (Seguro Anti-Spam)
* **Quién es:** Es una lista donde anotamos los identificadores de todos los mensajes que el banco nos ha enviado.
* **Por qué la necesitamos:**
  Los bancos por internet son desconfiados: si nos mandan una notificación diciendo *"Oye, el pago de Juan Pérez fue liquidado con éxito"*, pero la conexión parpadea medio segundo, el banco cree que no escuchamos y nos vuelve a mandar exactamente el mismo mensaje 30 segundos después.
  Para que el contador no se confunda y procese la misma confirmación dos veces, antes de abrir cualquier notificación del banco miramos esta lista:
  * Si el código del evento ya está anotado en la lista, decimos: *«Ah, esta carta ya la leí hace un rato, es una copia duplicada»*, y la botamos a la basura sin tocar la plata.
  * Si es nuevo, lo anotamos en la lista y procedemos a procesarlo.

---

### ¿Cómo se Hablan Entre Ellas? (La Película Completa)

Imagina que eres testigo de lo que pasa detrás de escena cuando Marea Pay envía $500:

```text
PASO 1: EL CLIENTE PIDE EL PAGO (En la ventanilla de la API)
─────────────────────────────────────────────────────────────────────────────
1. transfers toma la orden: anota el monto, quién envía, y le pone status='created'.
2. ledger_entries actúa de inmediato: anota un 'hold' de -$514.50. 
   (El cliente ve que su saldo disponible bajó de inmediato para no gastarlo dos veces).
3. outbox recibe el paquete: anota una tarea 'transfer.submit' con status='pending'.
La API le dice al cliente: "¡Listo, tu orden está en proceso!" (Tardó 20 milisegundos).

                                     │
                                     ▼

PASO 2: EL MENSAJERO SALE A ENTREGAR AL BANCO (El Worker en segundo plano)
─────────────────────────────────────────────────────────────────────────────
1. outbox mira su bandeja: ve la tarea pendiente y carga los datos desde transfers.
2. outbox llama al banco: "Banco aliado, por favor procesa este pago".
3. El banco responde: "Recibido, anótate este número de radicado: PROV-0001".
4. transfers se actualiza: guarda el código PROV-0001 y cambia su estado a 'submitted'.
5. outbox se archiva: marca la tarea como 'processed'. La entrega al banco concluyó.

                                     │
                                     ▼

PASO 3: EL BANCO AVISA HORAS DESPUÉS (El Webhook que regresa del banco)
─────────────────────────────────────────────────────────────────────────────
1. processed_events revisa el sobre: "¿Ya procesamos este evento EVT-999 antes?".
   Si ya lo procesó, lo ignora. Si es nuevo, lo registra en su lista.
2. transfers busca la orden: busca cuál de todas sus órdenes tiene el radicado PROV-0001.
3. ledger_entries hace la magia contable:
   * Si el banco dice "Éxito total (settled)": anota 'debit' (-$514.50) y 'release' (+$514.50).
     La plata se fue para siempre al destinatario y se borra el hold.
   * Si el banco dice "Rechazado o Reversado (reversed)": anota solo 'release' (+$514.50).
     El dinero se descongela intacto y regresa a la cuenta de Marea Pay.
4. transfers cierra el ciclo: cambia su estado al estado final definitivo ('settled' o 'reversed').
```

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

```text
Saldo Disponible = sum(credit) + sum(release) - sum(debit) - sum(hold)
```

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

---

## 7. Bitácora Maestra de Problemas Resueltos en Producción (Tickets 201, 202 y 203)

Esta sección es tu guía de estudio y referencia profunda. Explica con exactitud quirúrgica cada problema que hemos enfrentado en el sistema, la física del fallo, los flujos paso a paso, los archivos de código involucrados, la comparación de código (antes vs después) y el impacto contable en el balance del cliente.

---

### TICKET-201: Doble Pago al Proveedor por Reintentos Concurrentes (`CID-201`)

#### 1. El Problema en el Negocio (Riesgo de Pérdida Financiera)
Marea Pay envía una transferencia de $500.00 USD. La red celular del cliente tiene micro-cortes, por lo que su aplicación móvil/frontend no recibe respuesta inmediata y reintenta la misma petición automáticamente a los 50 milisegundos con el **mismo `Idempotency-Key`**.
Ambas peticiones llegan en paralelo exacto a dos hilos del servidor. Como el sistema no controlaba la concurrencia a nivel de base de datos, ambas pasaron, creando **dos pagos idénticos al banco**. Al cliente se le cobraron $1,000.00 y el banco entregó $1,000.00 al destinatario.

#### 2. Archivos Involucrados
* `db.ts`: Esquema de la tabla `transfers`.
* `transfers.ts`: Función `createOutboundTransfer()`.
* `regression.test.ts`: Test con `Promise.all` simulando dos llamadas simultáneas.

#### 3. El Flujo del Fallo (Timeline Paso a Paso)
```text
TIEMPO     PETICIÓN 1 (Hilo A)                         PETICIÓN 2 (Hilo B)
  │
  ├─ t0    Llega POST /transfers (idem="idem-201")      Llega POST /transfers (idem="idem-201")
  │
  ├─ t1    SELECT * FROM transfers WHERE key = 'idem'   SELECT * FROM transfers WHERE key = 'idem'
  │        (Respuesta: NULL, no existe)                 (Respuesta: NULL, no existe)
  │
  ├─ t2    INSERT INTO transfers (id="TX-0001") ──┐     INSERT INTO transfers (id="TX-0002") ──┐
  │        (BD sin UNIQUE: la guarda con éxito)   │     (BD sin UNIQUE: la guarda con éxito)   │
  │                                               ▼                                            ▼
  ├─ t3    post(ledger, entry_type: 'hold')  (-$514.50) post(ledger, entry_type: 'hold')  (-$514.50)
  │
  ├─ t4    insert into outbox ('transfer.submit')       insert into outbox ('transfer.submit')
  │
  ▼        ¡RESULTADO FATAL: 2 transferencias creadas, doble hold y 2 pagos enviados al banco!
```

#### 4. Código: Antes vs Después

**Antes (`src/transfers.ts` - Vulnerable):**
```typescript
// Patrón vulnerable "Check-then-Act":
const existing = await getByIdemKey(db, opts.idempotency_key);
if (existing) return existing; // Ambas peticiones leen NULL casi al mismo milisegundo

await db.query(`insert into transfers ...`); // Ambas insertan
await post(db, { entry_type: 'hold', ... }); // Doble hold
await db.query(`insert into outbox ...`);     // Doble despacho
```

**Después (`src/db.ts` + `src/transfers.ts` - Blindado con ACID):**
```typescript
// 1. En src/db.ts:
// idempotency_key text UNIQUE

// 2. En src/transfers.ts:
try {
  await db.query(
    `insert into transfers(id, account_id, direction, rail, amount_cents, fee_cents, status, idempotency_key, scenario)
     values ($1,$2,'outbound',$3,$4,$5,'created',$6,$7)`,
    [id, opts.account_id, opts.rail, opts.amount_cents, fee, opts.idempotency_key ?? null, opts.scenario ?? null]
  );
} catch (err: any) {
  // Si otra petición ganó la carrera en la BD (error PostgreSQL 23505),
  // atrapamos la colisión y devolvemos de inmediato la transferencia ganadora:
  if (opts.idempotency_key) {
    const existing = await getByIdemKey(db, opts.idempotency_key);
    if (existing) {
      log('transfer.idempotent_hit', { idempotency_key: opts.idempotency_key, transfer_id: existing.id }, cid);
      return existing; // <-- ¡Sale de inmediato sin ejecutar hold ni outbox!
    }
  }
  throw err;
}
```

#### 5. Por qué esta Solución es Perfecta
1. **La base de datos es la única fuente de verdad:** Ningún framework o semáforo en memoria funciona si tienes múltiples contenedores o servidores Node.js. El constraint `UNIQUE` de PostgreSQL garantiza que a nivel de disco físico solo UNA fila existirá con esa clave.
2. **Cero efectos secundarios:** Al hacer `return existing` dentro del `catch`, la petición perdedora nunca llega a ejecutar `post(hold)` ni a insertar en `outbox`.

---

### TICKET-202: Payout Reversado Queda Atascado con Fondos Congelados (`CID-202`)

#### 1. El Problema en el Negocio (Cliente con Fondos Bloqueados Injustamente)
Un cliente intenta enviar un pago cripto de $600.00 USD (tarifa $17.40 = total congelado $617.40). El proveedor externo rechaza la operación en la blockchain y notifica a Kira mediante webhook: `status = 'reversed'`.
Sin embargo, pasan las horas y en la aplicación de Marea Pay el pago sigue en estado `submitted` y sus $617.40 siguen congelados, impidiéndole usar su propio dinero.

#### 2. Archivos Involucrados
* `transfers.ts`: Función `applyProviderResult()`.
* `providers.ts`: Escenario `'reversed'`.
* `webhooks.ts`: Función `handleWebhook()`.
* `regression.test.ts`: Test que valida estado `reversed` y 100% del saldo restaurado.

#### 3. El Flujo del Fallo
```text
[ Proveedor ] ──► Envía Webhook: { status: 'reversed', provider_ref: 'PROV-0001' }
       │
       ▼
[ handleWebhook ] (src/webhooks.ts)
       │ Deduplica y encuentra transferencia asociada
       ▼
[ applyProviderResult ] (src/transfers.ts)
       │
       ├─ ¿status === 'pending'?   ❌ No
       ├─ ¿status === 'settled'?   ❌ No
       ├─ ¿status === 'failed'?    ❌ No
       ├─ ¿status === 'returned'?  ❌ No
       │
       ▼
  ¡No había rama para 'reversed'!
  La función terminaba en silencio sin hacer nada.
  * transfers.status se quedaba en 'submitted' para siempre.
  * Nunca se llamaba a post(ledger, entry_type: 'release').
  * Saldo del cliente seguía restando -$617.40 (Hold atrapado).
```

#### 4. Código: Antes vs Después

**Antes (`src/transfers.ts`):**
```typescript
if (status === 'pending') {
  await setStatus(db, transfer.id, 'pending');
} else if (status === 'settled') {
  await post(db, { entry_type: 'debit', ... });
  await post(db, { entry_type: 'release', ... });
  await setStatus(db, transfer.id, 'settled');
} else if (status === 'failed') {
  await post(db, { entry_type: 'release', ... });
  await setStatus(db, transfer.id, 'failed');
} else if (status === 'returned') {
  await post(db, { entry_type: 'release', ... });
  await setStatus(db, transfer.id, 'returned');
}
// ¡'reversed' ni siquiera existía!
```

**Después (`src/transfers.ts`):**
```typescript
} else if (status === 'failed' || status === 'returned' || status === 'reversed') {
  if (!hasRelease) {
    await post(db, {
      transfer_id: transfer.id,
      account_id: transfer.account_id,
      entry_type: 'release',
      amount_cents: total,
      memo: `release hold (${status})`
    });
  }
  await setStatus(db, transfer.id, status);
}
```

#### 5. Impacto en el Balance Contable
* **Saldo Inicial:** $1,000.00 (100,000 centavos).
* **Al crear la transferencia:** Se emite `hold` de -$617.40. Saldo disponible = **$382.60**.
* **Al recibir el webhook `reversed`:** Se emite `release` de +$617.40. No se emite `debit` porque la plata nunca salió de Kira hacia el destinatario.

```text
Saldo Final = +100,000 (credit) - 61,740 (hold) + 61,740 (release)
            = 100,000 centavos ($1,000.00 USD)
```

El saldo disponible regresa intacto al cliente al 100% y la orden queda en estado terminal auditado `reversed`.

---

### TICKET-203: Proveedor Pagó pero Mostramos 'Failed' y Saldo Inflado (`CID-203`)

#### 1. El Problema en el Negocio (Riesgo Crítico de Sobregiro y Pérdida de Capital)
Este es el fallo más peligroso en sistemas financieros.
Marea Pay envía un pago de $750.00 USD (tarifa $21.75 = total $771.75).
El banco procesa el pago y el dinero llega al destinatario. El banco envía un webhook avisando: `status: 'settled'` (éxito).
Sin embargo, por latencias en la red del banco, llega milisegundos después un webhook desordenado o tardío diciendo `status: 'failed'`.
El sistema de Kira procesó ese segundo webhook ciegamente:
1. Cambió el estado de la transferencia de `settled` a `failed`.
2. Hizo un **segundo `release`** en el ledger.
3. **El desastre:** ¡El dinero fue pagado al destinatario en el mundo real, pero al cliente se le devolvieron sus $771.75! Si el cliente retira ese dinero, Kira pierde capital propio.

#### 2. Archivos Involucrados
* `transfers.ts`: Función `applyProviderResult()`.
* `providers.ts`: Escenario `out_of_order`.
* `ledger.ts`: Función `availableCents()` (fórmula contable).
* `regression.test.ts`: Test con `scenario: 'out_of_order'`.

#### 3. El Flujo del Fallo (Desorden de Red y Doble Release)
```text
1. Transferencia creada ($771.75):
   Ledger: hold (-$771.75). Saldo disponible baja de $1,000.00 a $228.25.

2. Webhook 1 llega: status = 'settled'
   - Inserta debit (-$771.75) y release (+$771.75).
   - Saldo disponible: $1000 - 771.75 (hold) + 771.75 (release) - 771.75 (debit) = $228.25. (¡Correcto!)
   - transfers.status = 'settled'.

3. Webhook 2 llega (tardío / fuera de orden): status = 'failed'
   - El código NO chequea si ya estaba 'settled'.
   - Sobreescribe transfers.status a 'failed'.
   - Inserta un SEGUNDO release (+$771.75).
   
4. Fórmula del Saldo en ledger.ts:
   bal = credit (+1000) - hold (771.75) + release1 (771.75) - debit (771.75) + release2 (771.75)
   bal = $1,000.00 USD  <--- ¡EL CLIENTE TIENE OTRA VEZ SUS $1,000.00 Y EL BANCO YA PAGÓ LOS $771.75!
```

#### 4. Código: Antes vs Después

**Antes (`src/transfers.ts` - Ciego a la Máquina de Estados):**
```typescript
export async function applyProviderResult(db, transfer, status, cid) {
  // Confiaba ciegamente en el parámetro status recibido:
  if (status === 'settled') {
    await post(db, { entry_type: 'debit', ... });
    await post(db, { entry_type: 'release', ... });
    await setStatus(db, transfer.id, 'settled');
  } else if (status === 'failed') {
    // Si ya era 'settled', ¡hacía otro release y degradaba a failed!
    await post(db, { entry_type: 'release', ... });
    await setStatus(db, transfer.id, 'failed');
  }
}
```

**Después (`src/transfers.ts` - Con Invariante Terminal e Idempotencia Contable):**
```typescript
export async function applyProviderResult(db: PGlite, transfer: any, status: string, cid = '-') {
  const total = Number(transfer.amount_cents) + Number(transfer.fee_cents);

  // 1. Consultar estado real de la BD y asientos previos del ledger
  const current = (await db.query<any>(`select status from transfers where id = $1`, [transfer.id])).rows[0];
  const currentStatus = current?.status ?? transfer.status;

  const entries = (await db.query<any>(`select entry_type from ledger_entries where transfer_id = $1`, [transfer.id])).rows;
  const hasDebit = entries.some((e: any) => e.entry_type === 'debit');
  const hasRelease = entries.some((e: any) => e.entry_type === 'release');

  // 2. Invariante de Estado Terminal: Una vez liquidado ('settled'), ningún evento tardío de fallo puede revocarlo
  if (currentStatus === 'settled' && status !== 'settled') {
    log('transfer.out_of_order_ignored', { transfer_id: transfer.id, current_status: currentStatus, ignored_status: status }, cid, 'warn');
    return; // <-- Descarta el evento tardío sin tocar el ledger ni la BD
  }

  // 3. Idempotencia Contable: Máximo 1 debit y máximo 1 release por transferencia
  if (status === 'pending') {
    if (currentStatus === 'created' || currentStatus === 'submitted') {
      await setStatus(db, transfer.id, 'pending');
    }
  } else if (status === 'settled') {
    if (!hasDebit) {
      await post(db, { transfer_id: transfer.id, account_id: transfer.account_id, entry_type: 'debit', amount_cents: total, memo: 'settle outbound' });
    }
    if (!hasRelease) {
      await post(db, { transfer_id: transfer.id, account_id: transfer.account_id, entry_type: 'release', amount_cents: total, memo: 'release hold (settled)' });
    }
    await setStatus(db, transfer.id, 'settled');
  } else if (status === 'failed' || status === 'returned' || status === 'reversed') {
    if (!hasRelease) {
      await post(db, { transfer_id: transfer.id, account_id: transfer.account_id, entry_type: 'release', amount_cents: total, memo: `release hold (${status})` });
    }
    await setStatus(db, transfer.id, status);
  }

  log('transfer.provider_result', { transfer_id: transfer.id, from: currentStatus, provider_status: status }, cid);
}
```

#### 5. Explicación «Hablada» de Cada Comprobación (Para Entenderlo Sin Rodeos Técnicos)

Si tuvieras que explicarle este código a un compañero o en una entrevista de forma completamente natural y sin tecnicismos enredados, así es como razona cada línea:

* **1. `current` y `currentStatus` (No confíes en chismes, mira la realidad fresca):**
  * *La intuición cotidiana:* Imagina que alguien entra a tu oficina y te dice: *"Oye, el pago TX-0001 sigue en camino (`submitted`)"*. Pero ese aviso te lo dieron basado en una foto de hace unos minutos. Tú no tomas una decisión de miles de dólares por un papel viejo. Vas a la base de datos (`SELECT status FROM transfers`) y preguntas: *"¿Qué dice el sistema AHORA MISMO?"*. Y el sistema te responde: *"Oye, hace 3 segundos el banco ya confirmó que el dinero llegó al destinatario (`settled`)"*. Consultar `current` es simplemente **comprobar la realidad en tiempo real** antes de tocar el dinero.

* **2. `entries`, `hasDebit` y `hasRelease` (La libreta de notas del tendero y el peligro del dinero fantasma):**
  * *La intuición cotidiana:* El libro contable (`ledger_entries`) es como la libreta donde un tendero anota cada moneda con tinta indeleble. Recuerda la fórmula: `Saldo = crédito + release - débito - hold`.
    * Cada pago nace con **1 solo `hold`** (-$500).
    * Si metes dos veces `release` (+500 y +500), el primer release cancela el hold, pero el segundo release **¡le regala $500 de dinero fantasma al cliente!** (La empresa quiebra).
    * Si metes dos veces `debit` (-500 y -500), **¡le cobras el doble ($1,000) al cliente!** (El cliente nos demanda).
  * Por eso, antes de tocar el dinero, el tendero abre la libreta y se hace dos preguntas con sentido común:
    * `hasDebit`: *«¿Yo ya le cobré definitivamente este dinero de su cuenta?»*
    * `hasRelease`: *«¿Yo ya le devolví o descongelé la plata que le tenía guardada en garantía?»*
  * Si la libreta dice *"Sí, ya se la descongelaste hace un minuto"*, el tendero dice: *"Ah, ni loco se la vuelvo a descongelar, porque si lo hago le estaría regalando plata de mi propio bolsillo"*. Esas dos variables son la memoria histórica del dinero para no cometer torpezas.

* **3. El gran candado: `if (currentStatus === 'settled' && status !== 'settled') return;` (La ley del hecho consumado):**
  * *La analogía del avión:* Una transferencia es como un vuelo: `created` (compras el pasaje) ➔ `submitted` (el avión despega) ➔ `settled` (aterrizaste en el destino).
  * Imagina que el avión ya aterrizó en París, te bajaste y estás comiendo un croissant en el aeropuerto (`settled`). Cinco minutos después, te llega un mensaje de texto automático diciendo: *"Aviso: su vuelo fue cancelado en la puerta de embarque (`failed`)"*.
  * ¿Acaso vas a teletransportarte de vuelta y devolverte? ¡No! El vuelo ya ocurrió en el mundo real.
  * Si la aerolínea creyera ciegamente en ese mensaje desordenado, diría: *"Uy, se canceló, devolvámosle los $1,000 del pasaje"*, y tú habrías viajado gratis a París a costa de la aerolínea.
  * Por eso este `if` es tajante: **si el banco ya liquidó la plata en el mundo real, cualquier mensaje posterior diciendo que "falló" es un rezago de la red y se tira a la basura de inmediato (`return;`).**

* **4. Los `if (!hasDebit)` y `if (!hasRelease)` dentro de `settled`:**
  * *La intuición cotidiana:* *"El banco me confirma que el pago salió bien. Perfecto: si todavía no le había cobrado de verdad, le cobro (`!hasDebit`). Si todavía tenía su dinero congelado en garantía, se lo descongelo (`!hasRelease`). Pero si alguna de esas dos cosas ya la había hecho antes, ¡no la vuelvo a hacer!"*.

* **5. El `if (!hasRelease)` dentro de `failed`, `returned` o `reversed`:**
  * *La intuición cotidiana:* *"El banco me avisa que la transferencia no se pudo completar. Justo es devolverle la plata al cliente. Pero primero reviso: ¿ya se la devolví? Si no se la he devuelto (`!hasRelease`), se la suelto. Si ya se la había devuelto en otro paso, no hago nada más"*.

---

#### 6. Por qué esta Solución es Definitiva y a Prueba de Balas
1. **Protección de la Fuente de Verdad:** Si el dinero ya salió del banco hacia el beneficiario (`settled`), esa es la realidad física y contable. Un paquete de red retrasado no puede alterar la realidad física.
2. **Defensa en Profundidad (Doble Candado):**
   * *Candado 1:* `if (currentStatus === 'settled' && status !== 'settled') return;` corta el procesamiento de raíz.
   * *Candado 2:* Aun si algún día entrara otro flujo extraño, `if (!hasRelease)` y `if (!hasDebit)` impiden matemáticamente que en el ledger se dupliquen débitos o liberaciones para la misma transferencia.

---

### TICKET-204: Servidor se Cae a Mitad de la Petición y Fondos Quedan Atrapados (`CID-204`)

#### 1. Qué Pasaba en el Negocio (El Dolor del Cliente)
* **El síntoma:** El cliente manda una transferencia por $400 USD. En ese instante exacto, el servidor sufre una caída (un crash por falta de memoria, corte de luz o fallo de red).
* **El desastre:** Cuando el cliente revisa su cuenta, ve que le faltan los $400 USD (están congelados en `hold`), pero la transferencia aparece en estado `created` para siempre. Peor aún: el dinero jamás le llega al destinatario porque nadie lo envió al banco. Y si el cliente intenta volver a mandar la plata con la misma clave, el sistema le dice que la transferencia ya existe y no la mueve.

#### 2. Causa Raíz: La Trampa de las 3 Consultas Separadas (Sin Transacción)
En el código original de `createOutboundTransfer`, el proceso de enviar dinero se dividía en **3 pasos secuenciales e independientes**:

1. **Paso 1 (`transfers`):** Guardar el registro de la orden con estado inicial `created`.
2. **Paso 2 (`ledger_entries`):** Congelar la plata en el libro contable metiendo una fila de tipo `hold` (monto + comisión).
3. **Paso 3 (`outbox`):** Meter la tarea en la tabla outbox para que el worker en segundo plano la tome y se la envíe al banco.

💥 **¿Dónde estaba el error fatal?**
El error ocurría si había un fallo **entre el Paso 2 y el Paso 3**:
* El Paso 1 y el Paso 2 ya habían quedado grabados en la base de datos: la transferencia existía y el saldo estaba retenido.
* Pero si el proceso se caía justo ahí, el Paso 3 **NUNCA se ejecutaba**: la tarea jamás llegaba a la tabla `outbox`.
* Como el worker solo lee la tabla `outbox`, **nunca se enteraba de que esa transferencia existía**. El dinero quedaba secuestrado de por vida sin enviarse al banco.

#### 3. La Solución: Atomicidad con `db.transaction` (La Regla del "Todo o Nada")
Para solucionar esto, envolvimos los 3 pasos dentro de una **transacción atómica** usando `db.transaction(async (tx) => { ... })`:

* **O se ejecutan los 3 pasos, o no se ejecuta ninguno.**
* Si el servidor se cae entre el Paso 2 y el Paso 3, la base de datos ejecuta un `ROLLBACK` automático:
  * Borra la retención del libro contable (Paso 2 deshecho: el dinero vuelve a estar disponible al 100%).
  * Borra el registro de la transferencia (Paso 1 deshecho: la base de datos queda limpia).
* Cuando el servidor vuelve a encenderse o el cliente reintenta la petición con su misma `idempotency_key`, la cuenta está intacta con su saldo completo y la transferencia se puede crear desde cero con total normalidad.

---

### TICKET-205: El Proveedor Bancario Paga Dos Veces por un Timeout (`CID-205`)

#### 1. Qué Pasaba en el Negocio (El Doble Pago al Destinatario)
* **El síntoma:** En el extracto del banco aparecían **dos cargos de $1,200.00** al mismo destinatario. Pero en nuestro sistema solo existía una transferencia y solo le cobramos una vez al cliente. Es decir, perdimos $1,200.00 de nuestro bolsillo.
* **La pista en los logs:** Aparecía un aviso sospechoso: `webhook.unknown_transfer: provider_ref='PROV-0008'`.

#### 2. Causa Raíz: Reintentos hacia el Banco sin Idempotencia (Outbound Non-Idempotent Retries)
Así como el cliente debe mandarnos una clave de idempotencia a nosotros (Ticket 201), **nosotros tenemos la obligación de mandarle nuestra propia clave de idempotencia al banco**.

¿Qué pasaba en el worker (`outbox.ts`)?
1. **Intento 1:** El worker llamaba a `provider.submit(t)` sin pasarle ninguna clave.
   * El banco recibía la orden, creaba el pago `PROV-0008` y lo procesaba.
   * Pero la respuesta HTTP del banco tardó demasiado y dio **timeout** de red.
   * Como la llamada falló con error de timeout, nuestro servidor creyó que el pago no se había hecho, no guardó la referencia `PROV-0008` y dejó la tarea en `pending`.
2. **Intento 2:** En la siguiente ronda, el worker reintentó la tarea y volvió a llamar a `provider.submit(t)` **sin clave**.
   * El banco no sabía que era un reintento. Pensó: *"Ah, me están pidiendo OTRA transferencia distinta de $1,200"*.
   * El banco creó un segundo pago bancario (`PROV-0020`), le giró otros $1,200 al destinatario y nos devolvió `PROV-0020`.
   * Nuestro sistema guardó `provider_ref = 'PROV-0020'` creyendo que ese era el único pago.
3. **El webhook huérfano:** Cuando el banco nos mandó el webhook del primer pago (`PROV-0008`), nuestro sistema lo buscó en la base de datos, no lo encontró (porque teníamos guardado `PROV-0020`) y lo descartó como "transferencia desconocida" (`unknown_transfer`).

#### 3. La Solución: Propagación de Idempotencia de Extremo a Extremo
Al llamar al proveedor en `outbox.ts`, le enviamos el identificador inmutable de nuestra transferencia (`t.id`) como clave de idempotencia:
```typescript
const res = provider.submit(t, t.id);
```
* Si ocurre un timeout y el worker reintenta, el banco recibe el mismo `t.id`.
* El banco revisa su historial: *"Momento, yo ya procesé esta orden con la referencia PROV-0008"*.
* El banco **NO duplica el pago**, nos devuelve la referencia original `PROV-0008`, y el dinero sale exactamente una sola vez.

---

### TICKET-206: La Conciliación Diaria No Cuadra en Cero (Descuadre de Comisiones y Redondeo Bancario) (`CID-206`)

#### 1. Qué Pasaba en el Negocio (El Dolor de Finanzas)
* **El síntoma:** Al final del día, el departamento de Finanzas de Kira ejecuta el proceso de conciliación (`GET /reconciliation`). El sistema compara el extracto bancario del proveedor contra nuestro libro contable (`ledger_entries`) y arroja una alerta roja:
  * La diferencia neta no es $0.00 USD, sino que hay un descuadre (`diff = 3c`).
  * Hay 3 transferencias con comisiones descuadradas (`fee mismatches = 3`).
  * Además, antes de arreglar el Ticket 205, aparecía un pago fantasma que solo estaba en el extracto del banco (`statementOnly = 1` por $1,200.00).
* **El impacto:** En auditoría financiera y contabilidad bancaria, un descuadre de un solo centavo frena el cierre contable y puede generar sanciones regulatorias o pérdidas acumuladas de capital a lo largo de millones de transacciones.

#### 2. Causa Raíz: Truncamiento vs Redondeo Bancario (*Round Half-Up*)
El descuadre se debía a dos motivos:
1. **El pago duplicado del Ticket 205:** Al duplicarse el pago de $1,200.00 por el timeout sin idempotencia, en el extracto del banco sobraba una transacción que no teníamos en nuestro sistema. Al resolver el Ticket 205 con `provider.submit(t, t.id)`, los pagos huérfanos bajaron a 0 (`statementOnly = 0`).
2. **La discordancia de redondeo en las comisiones:**
   * La comisión de plataforma es del **2.9%** (`rate = 0.029`).
   * En el banco/proveedor (`src/providers.ts`), la comisión se calculaba usando **Round Half-Up** (redondeo clásico a la mitad superior):
     ```typescript
     fee_cents: Math.floor(s.amount_cents * 0.029 + 0.5)
     ```
   * En nuestro sistema (`src/money.ts`), la función `feeCents` usaba **truncamiento puro hacia abajo** con `Math.floor`:
     ```typescript
     return Math.floor(amountCents * rate);
     ```
   * Cuando el 2.9% daba una fracción con medio centavo o más (ej. `.5` o `.7` centavos), **Kira cobraba 1 centavo de menos**, mientras que el banco nos cobraba el centavo completo:
     * Orden `TX-0004` ($1,555.00 = 155,500 centavos):
       $155,500 \times 0.029 = 4,509.5$ centavos.
       Kira calculaba: `Math.floor(4509.5) = 4509` centavos ($45.09).
       El banco calculaba: `Math.floor(4509.5 + 0.5) = 4510` centavos ($45.10).
       **Descuadre:** -1 centavo.
     * Orden `TX-0005` ($1,724.00):
       $172,400 \times 0.029 = 4,999.6$ centavos.
       Kira calculaba: 4,999 centavos. El banco: 5,000 centavos.
       **Descuadre:** -1 centavo.
     * Orden `TX-0006` ($883.00):
       $88,300 \times 0.029 = 2,560.7$ centavos.
       Kira calculaba: 2,560 centavos. El banco: 2,561 centavos.
       **Descuadre:** -1 centavo.
   * Resultado: exactamente 3 descuadres de comisión y 3 centavos de diferencia neta total.

#### 3. La Solución: Alinear el Algoritmo de Redondeo en `src/money.ts`
En `src/money.ts`, cambiamos el truncamiento por redondeo simétrico al centavo más cercano:
```typescript
export function feeCents(amountCents: Cents, rate = 0.029): Cents {
  // Redondea al centavo más cercano (Round Half-Up), alineado con la fórmula del banco
  return Math.round(amountCents * rate);
}
```
*(Nota: `Math.round(x)` en JavaScript es matemáticamente equivalente para números positivos a `Math.floor(x + 0.5)` que utiliza el proveedor).*

Con este ajuste:
* Las comisiones calculadas por Kira coinciden al 100% centavo a centavo con el banco.
* La conciliación de fin de día arroja:
  `diff = 0c`, `fee mismatches = 0`, `statement-only = 0`, `ledger-only = 0`.
* ¡Cierre contable perfecto y cuadrado en cero!

---

### Resumen Comparativo de los Tickets

| Ticket | Síntoma Reportado | Causa Raíz (Bug) | Solución Técnica | Archivos Editados |
| :--- | :--- | :--- | :--- | :--- |
| **201** | Doble cobro y doble pago al destinatario en peticiones simultáneas con el mismo `Idempotency-Key`. | Falta de constraint `UNIQUE` en `transfers.idempotency_key` y patrón no atómico de lectura previa. | `UNIQUE` en esquema + captura de colisión PostgreSQL `23505` con retorno inmediato de la transferencia ganadora. | `db.ts`<br>`transfers.ts` |
| **202** | Pago cancelado/reversado por el proveedor queda en `submitted` y fondos congelados en la cuenta. | `applyProviderResult` no manejaba el estado `'reversed'` en su condicional de webhooks. | Añadida rama `'reversed'` que emite `release` en ledger y transiciona a estado terminal `reversed`. | `transfers.ts` |
| **203** | Pago exitoso en el banco aparece como `failed` en Kira y saldo del cliente queda sobregirado/inflado. | Webhooks fuera de orden (`settled` luego `failed`) sobreescribían estado terminal y emitían doble `release`. | Invariante de estado terminal (`settled` inmutable) + verificación de idempotencia en ledger (`!hasRelease`, `!hasDebit`). | `transfers.ts` |
| **204** | Servidor se cae a mitad de la petición: transferencia queda varada en `created` con fondos retenidos y nunca se procesa. | Operaciones no atómicas (3 `INSERT` independientes sin transacción). Si se cae el proceso antes de la outbox, la plata queda atrapada. | Transacción atómica `db.transaction` (o se crean transferencia + hold + outbox, o rollback total y fondos intactos). | `transfers.ts` |
| **205** | El banco cobra y paga dos veces tras un timeout de red del proveedor (`CID-205`). | El worker reintentaba la llamada al banco sin pasarle clave de idempotencia (`provider.submit(t)`). | Enviar `t.id` como `idemKey` al banco (`provider.submit(t, t.id)`), evitando pagos duplicados en el proveedor. | `outbox.ts` |
| **206** | La conciliación diaria no cuadra en cero (diferencia de 3 centavos y 3 comisiones descuadradas). | `feeCents` usaba truncamiento (`Math.floor`) en vez de redondeo simétrico (`Round Half-Up`), cobrando 1 centavo de menos en montos con fracción $\ge 0.5$. | Cambiar `Math.floor` por `Math.round(amountCents * rate)` en `src/money.ts` para alinearse 1:1 con la fórmula del extracto bancario. | `money.ts` |


---

## 8. Mis Apuntes para la Entrevista: Cómo Explicar el Proyecto y Preguntas Clave

Dejo aquí un resumen rápido y al grano para repasar antes de la prueba o entrevista, con las preguntas típicas que seguro van a salir.

---

### 1. Cómo explicar el proyecto en mis propias palabras

Si me piden resumir de qué trata este servicio y cómo funciona, la idea clave es:

> "Es un backend financiero para mover dinero internacionalmente con cuentas virtuales en USD (como las que usa Marea Pay), soportando pagos por red bancaria tradicional (ACH) y por cripto.
>
> Lo más importante del diseño es:
> 1. **La plata nunca se edita a mano:** Usamos un libro contable inmutable (*ledger*). Cada movimiento es una fila nueva. Cuando alguien pide transferir, congelamos el dinero con un `hold` preventivo para que no se lo gaste.
> 2. **No llamamos al banco directo en la API (Outbox Pattern):** Guardamos la orden y dejamos la tarea pendiente en una tabla `outbox`. Un worker en segundo plano se encarga de enviarla al banco con reintentos si falla la red.
> 3. **Todo el desenlace llega por Webhook:** Cuando el banco realmente paga o rechaza horas después, nos avisa por webhook. Ahí deduplicamos para no procesar mensajes repetidos, y si fue exitoso (`settled`), cobramos el débito real y quitamos la retención. Si falló o se reversó, simplemente le descongelamos la plata al cliente."

---

### 2. Banco Maestro de Preguntas de Entrevista (Organizadas por Categoría)

---

#### 📌 BLOQUE A: Lógica de Negocio y FinTech Core (*How Money Moves*)

##### P1: "¿Por qué no guardar el saldo en una columna `balance` y restarle directamente en cada operación?"
* **Cómo lo explico:**
  * Porque en finanzas reales no puedes perder el rastro del dinero. Si editas una columna `balance` directamente y ocurre un bug o corrupción, no hay forma de saber qué pasó, a qué milisegundo ocurrió, ni por qué orden de pago.
  * Con un libro contable inmutable de doble partida (`ledger_entries`), el saldo disponible siempre se **calcula derivándolo de la suma y resta de movimientos históricos**:
    $$\text{Available Balance} = \sum \text{credits} - \sum \text{holds} - \sum \text{debits} + \sum \text{releases}$$
  * Esto proporciona **auditoría forense total** segundo a segundo, inmutabilidad y la capacidad de conciliar contra los extractos bancarios al final del día.

##### P2: "¿Cuál es la diferencia entre un `hold`, un `debit` y un `release`? ¿Por qué congelamos `amount + fee` y no solo el monto?"
* **Cómo lo explico:**
  * **`hold` (Reserva preventiva):** Bloquea saldo de forma provisional. La plata aún pertenece formalmente a la cuenta, pero el cliente ya no puede gastársela mientras el banco procesa la orden (evita el sobregiro o doble gasto).
  * **`debit` (Salida definitiva):** Cuando el banco confirma que el dinero llegó al destinatario (`settled`), el dinero se retira definitivamente del patrimonio del cliente.
  * **`release` (Liberación):** Descongela la reserva previa. Si el pago fue exitoso, se quita el hold para que no quede duplicada la retención con el débito. Si el pago falló o se reversó, el release regresa el dinero intacto al saldo disponible.
  * **¿Por qué congelamos monto + tarifa (`amount + fee`)?:** Porque si un cliente tiene $500 y pide girar $500, la comisión es de $14.50 (total $514.50). Si solo congeláramos los $500, el cliente podría retirar los $14.50 restantes antes de que el banco liquide, dejando a Kira en pérdida neta. Se congela la obligación financiera total.

##### P3: "¿Por qué usamos el patrón *Transactional Outbox* en vez de llamar a la API del banco en el mismo endpoint HTTP?"
* **Cómo lo explico:**
  * Por **rendimiento, aislamiento de fallos y resiliencia de red**:
    1. **Latencia del cliente:** Una llamada HTTP a un riel bancario tradicional (ACH) o puente de pagos puede tardar entre 5 y 20 segundos. No podemos dejar congelada la conexión HTTP del cliente.
    2. **Fallo en dos fases (Two-Phase Failure):** Si llamamos al banco directamente y se corta la conexión de internet a mitad de camino, la API le devolvería un error 500 al cliente. El cliente asumiría que falló y reintentaría, pero el banco sí habría procesado el giro, provocando un doble cobro real.
    3. **La solución del Outbox:** La API guarda la intención en disco en milisegundos (`status = 'created'`, `hold`, y tarea en `outbox`) dentro de la misma transacción local de PostgreSQL. Luego, un worker en segundo plano se encarga de despachar la orden con reintentos exponenciales garantizados.

---

#### 📌 BLOQUE B: Preguntas Técnicas Ticket por Ticket (201 al 206)

##### P4 (Ticket 201): "¿Por qué resolviste la idempotencia con un `UNIQUE constraint` en PostgreSQL y no con un mutex o semáforo en memoria en Node.js?"
* **Cómo lo explico:**
  * **El fallo del mutex en producción:** En una infraestructura real de nube (Kubernetes, AWS ECS, Docker), Node.js corre escalado horizontalmente en múltiples contenedores o procesos detrás de un Load Balancer. Un mutex en memoria solo protege ese proceso local de Node. Si dos peticiones con el mismo `Idempotency-Key` llegan simultáneamente y el balanceador envía la petición 1 al Contenedor A y la petición 2 al Contenedor B, el mutex en memoria no se entera y ambas procesan la orden en paralelo, duplicando el pago.
  * **La solución en PostgreSQL:** La base de datos es la única fuente centralizada de verdad compartida. Un índice `UNIQUE(idempotency_key)` garantiza atomicidad a nivel de página/fila en disco con locks de PostgreSQL.
  * **El manejo del error 23505:** En TypeScript envolvemos el insert en un `try/catch`. Si la segunda petición entra en colisión, Postgres aborta la inserción con código `23505` (`unique_violation`). Atrapamos ese error y devolvemos de inmediato la transferencia original ganadora con HTTP 200/201. Para el cliente, la operación es perfectamente transparente e idempotente.

##### P5 (Ticket 202): "¿Qué pasaba cuando un pago era devuelto o cancelado por el banco en estado `reversed` y por qué la plata quedaba secuestrada?"
* **Cómo lo explico:**
  * El manejador de webhooks (`applyProviderResult`) solo tenía contemplados los estados terminales `'settled'`, `'failed'` y `'returned'`.
  * Cuando el banco emitía un webhook con `status = 'reversed'` (por ejemplo, cuenta bancaria cerrada en destino o recall de fondos), el condicional caía en un bloque vacío: la transferencia se quedaba atascada en `submitted` y nunca se registraba el asiento contable de `'release'`.
  * Como el `hold` inicial seguía activo sin su `release`, el dinero continuaba congelado de por vida y el cliente no podía disponer de sus fondos.
  * **La solución:** Agregamos el soporte explícito para `'reversed'`, emitiendo un `release` inmediato por `amount + fee` y actualizando el estado de la transferencia a `reversed`.

##### P6 (Ticket 203): "¿Cómo controlamos webhooks que llegan desordenados de la red y el riesgo de inflar el saldo del cliente?"
* **Cómo lo explico:**
  * **El escenario de fallo:** En redes asíncronas, los mensajes pueden llegar fuera de orden. El proveedor bancario enviaba primero un webhook de éxito (`settled`) y, minutos después por retrasos de red, un webhook tardío de fallo (`failed`).
  * El código anterior sobreescribía ciegamente el estado a `failed` y ejecutaba un nuevo `release` en el ledger. Como cada release suma saldo disponible, ¡el cliente tenía su dinero liquidado en el banco y además le estábamos regalando un saldo fantasma en su cuenta virtual!
  * **La solución con dos barreras:**
    1. **Invariante de Estado Terminal Inmutable:** Si en la base de datos la transferencia ya está en `settled`, cualquier webhook posterior que pretenda degradarla a `failed` o `reversed` es descartado de inmediato con una advertencia en el log.
    2. **Idempotencia Contable:** Antes de registrar asientos en `ledger_entries`, consultamos `hasDebit` y `hasRelease`. Una transferencia jamás puede tener más de un débito ni más de una liberación, garantizando que el saldo sea matemáticamente consistente sin importar cuántas veces se reintente el webhook.

##### P7 (Ticket 204): "¿Por qué el dinero quedaba varado si el servidor se caía a mitad de la petición y cómo lo soluciona `db.transaction`?"
* **Cómo lo explico:**
  * La creación de una transferencia requería 3 operaciones secuenciales independientes: (1) `insert into transfers`, (2) `hold` en `ledger_entries`, y (3) `insert into outbox`.
  * **El punto ciego:** Si ocurría un crash de Node o corte de energía justo después del paso 2 (el hold), la orden quedaba registrada y los fondos congelados, pero como la tarea jamás llegó a la tabla `outbox`, el worker nunca se enteraba. La plata del cliente quedaba en un "limbo" permanente sin enviarse al banco ni devolverse.
  * **La solución con Atomicidad ACID:** Envolvemos los 3 pasos en `db.transaction(async (tx) => { ... })`. La propiedad de **Atomicidad** garantiza que o se confirman los 3 pasos juntos (`COMMIT`), o si ocurre un fallo a mitad de camino, PostgreSQL ejecuta un `ROLLBACK` total. El hold y la transferencia desaparecen por completo, dejando el saldo disponible del cliente intacto al 100% para que cuando su sistema reintente, la llamada se procese limpia.
  * **Diferencia entre `db` y `tx`:** `db` es la instancia global del motor. `tx` es el objeto de la transacción aislada. Dentro de `db.transaction` es mandatorio pasar `tx` a todas las operaciones para mantenerse dentro de la burbuja transaccional protegida.

##### P8 (Ticket 205): "¿Por qué el banco procesó dos pagos tras un timeout de red del proveedor y cómo lo resolvimos?"
* **Cómo lo explico:**
  * La idempotencia tiene dos extremos: del cliente hacia nosotros, y de nosotros hacia el banco aliado.
  * En el worker (`src/outbox.ts`), cuando despachábamos la tarea llamábamos a `provider.submit(t)` sin pasarle ningún identificador de idempotencia. En el primer intento, el banco recibió el pago y lo debitó, pero la respuesta HTTP tardó más de la cuenta y dio timeout.
  * Nuestro worker asumió que la conexión falló y programó un reintento. Cuando volvió a llamar a `provider.submit(t)` sin clave de idempotencia, el banco creyó que era una orden de giro totalmente nueva y procesó un segundo pago idéntico ($2,400 en vez de $1,200).
  * **La solución:** Propagamos nuestro ID único de transferencia como clave de idempotencia downstream hacia el banco: `provider.submit(t, t.id)`. Al reintentar tras el timeout, el banco reconoce el `idemKey`, no cobra de nuevo, y devuelve la referencia original. El dinero sale exactamente una sola vez.

##### P9 (Ticket 206): "¿Por qué la conciliación diaria no cuadraba en cero por diferencias de 1 centavo y cómo se alineó el redondeo?"
* **Cómo lo explico:**
  * El proceso de conciliación (`reconcile`) cruza nuestras transferencias en estado `settled` contra el extracto bancario oficial (`provider.statement()`). Al final del día había un descuadre neto de 3 centavos y 3 discrepancias de comisión en órdenes como las de $1,555.00, $1,724.00 y $883.00.
  * **La causa raíz:** El banco calculaba la comisión del 2.9% usando redondeo al entero más cercano (*Round Half-Up*, fórmula `Math.floor(amount * 0.029 + 0.5)`). Pero Kira usaba truncamiento puro hacia abajo con `Math.floor(amount * 0.029)`. Cuando el 2.9% producía una fracción mayor o igual a 0.5 centavos (como 4,509.5c), Kira truncaba a 4509c mientras el banco redondeaba a 4510c. Perdíamos sistemáticamente 1 centavo por operación.
  * **La solución:** Cambiamos la fórmula en `src/money.ts` a `Math.round(amountCents * rate)`. En JavaScript para números positivos, `Math.round` es matemáticamente idéntico a `Math.floor(x + 0.5)`. Con esto, Kira y el banco calculan exactamente la misma tarifa centavo a centavo y la conciliación cierra en cero absoluto (`diffCents = 0`, 0 mismatches).

---

#### 📌 BLOQUE C: Entregables de Operación y Manejo de Crisis (Entregables 3 y 4)

##### P10 (Entregable 3): "¿Por qué construimos un monitor de triaje operativo (`/ops/triage` y CLI) en vez de usar solo métricas genéricas de Prometheus/Datadog?"
* **Cómo lo explico:**
  * En una FinTech de movimiento de fondos, las métricas de infraestructura (CPU, memoria, tasa de errores HTTP 500) son ciegas ante la corrupción del dinero: el servidor puede estar al 10% de CPU y con HTTP 200 mientras se están fugando miles de dólares por pagos duplicados o redondeos desfasados.
  * El monitor de triaje operativo (`src/triage.ts`) evalúa **invariantes de dominio financiero en vivo** cruzando directamente las tablas de PostgreSQL y los extractos bancarios:
    1. **Exposición Financiera en USD (`financialExposureUsd`):** Cuantifica exactamente cuántos dólares reales están en riesgo en ese instante.
    2. **Forense Inmediato:** Proporciona los IDs de cuentas y transferencias afectadas (`CID-201`, `ACC-MAREA`) para actuar sin perder tiempo en consultas manuales.
    3. **Runbook Accionable:** Cada anomalía incluye su `recommendedAction` (ej. *"Ejecutar release contable"*, *"Solicitar recall bancario"*).
  * Tenerlo por CLI (`npm run triage`) y por API (`GET /ops/triage`) permite que el ingeniero de guardia diagnostique el sistema en 1 segundo por terminal SSH o que sistemas de alerta automatizados disparen incidentes con contexto enriquecido.

##### P11 (Entregable 4 - Roleplay): "Si el Director de Operaciones de Marea Pay te llama alarmado por un doble cobro de $1,029 USD, ¿cuál es tu protocolo exacto de comunicación?"
* **Cómo lo explico:**
  * Aplico el protocolo de **Comunicación de Crisis FinTech en 4 tiempos inquebrantables**:
    1. **Empatía y Tranquilidad Financiera Primero (La Regla de Oro):**
       Antes de hablar de código o bases de datos, calmar el dolor del cliente asegurando sus fondos:  
       > *"Hola Juan, comprendo perfectamente la gravedad de la situación y la urgencia para su operación. Quiero darle tranquilidad inmediata: **ya hemos acreditado un crédito compensatorio de $514.50 USD en su cuenta `ACC-MAREA`. Su saldo disponible está 100% restablecido y Marea Pay asume cero pérdida económica.** Nosotros nos encargamos del trámite de recall con el banco receptor."*
    2. **Responsabilidad Total (Cero evasivas ni culpar al cliente):**
       > *"Revisamos su integración y confirmamos que su sistema operó según el estándar, enviando el mismo `Idempotency-Key` en el reintento. El problema ocurrió enteramente en nuestra capa de concurrencia al no detener la colisión en base de datos. Asumimos la total responsabilidad."*
    3. **Causa Raíz Transparente (RCA):**
       > *"El incidente se debió a una condición de carrera de sub-milisegundo: ambas peticiones ingresaron simultáneamente antes de que la primera quedara sellada en disco, creando dos órdenes en paralelo."*
    4. **Solución Permanente y Garantía de No Repetición:**
       > *"Hemos desplegado una restricción de unicidad estricta (`UNIQUE constraint`) en PostgreSQL con transacciones atómicas. Si un reintento vuelve a entrar en paralelo, el sistema lo deduplica en milisegundos y devuelve la orden original sin tocar su saldo ni emitir llamadas adicionales al banco. Además, hemos incorporado pruebas de estrés en CI y un monitor de triaje activo 24/7."*

---

### 3. Glosario rápido para tener los términos claros

* **Virtual Account:** Cuenta digital en dólares que le abrimos a empresas como Marea Pay para mover plata sin necesidad de tener cuenta física en EE.UU.
* **ACH:** Red de transferencias bancarias de EE.UU. Tarda de 1 a 2 días hábiles en compensar.
* **Crypto Rail:** Pagos con stablecoins (USDC) que liquidan en minutos en la blockchain.
* **Hold:** Bloqueo preventivo de saldo. No le quita la plata todavía al cliente, pero no lo deja gastársela mientras el banco procesa.
* **Release:** Desbloqueo del hold. Si el pago fue exitoso, se quita el hold y se debita la plata real. Si el pago falló, solo se quita el hold para que la plata vuelva a estar disponible.
* **Settlement:** Cuando el dinero llegó efectivamente a la cuenta bancaria del destinatario final.
* **Reconciliation:** Cruzar las transferencias de nuestro sistema contra el extracto bancario del proveedor para verificar que no falte ni sobre un solo centavo.

---

## 9. El Monitor de Triaje Operativo (Ops Triage Monitor - Entregable 3)

### 9.1 ¿Qué es y por qué existe este monitor?

Imagina que eres el **ingeniero de guardia (On-Call)** en Kira. A las 2:00 AM suena una alerta o entra un reporte de soporte. No tienes tiempo de entrar a la base de datos a tirar 20 consultas SQL complejas a mano mientras el cliente presiona por teléfono.

Necesitas una herramienta que ejecute un **chequeo médico completo del sistema en 1 segundo** y te responda con claridad:
1. ¿Hay dinero en riesgo ahora mismo? ($ USD exactos).
2. ¿Qué falló exactamente y en qué órdenes o cuentas?
3. ¿Cuál es el paso a paso (*Runbook*) que debo seguir para resolverlo de inmediato?

Para esto construimos **`src/triage.ts`**. Este módulo contiene **5 funciones diagnósticas**, cada una especializada en detectar una de las 5 clases de anomalías que descubrimos en los incidentes de producción.

---

### 9.2 Explicación Paso a Paso de las 5 Funciones Diagnósticas

---

#### 1. `checkDuplicatePayouts(db)` ➔ Doble Pago (Ticket 201 y 205)

* **Qué busca en el negocio:**
  Dinero que se haya cobrado o pagado dos veces por culpa de reintentos concurrentes o timeouts de red. Un doble pago puede ocurrir en **dos lugares distintos**:
  1. *En nuestra base de datos (Ticket 201):* Dos transferencias con la misma `idempotency_key`.
  2. *En el banco externo (Ticket 205):* Una sola transferencia en nuestra base de datos, pero el banco la recibió y cobró dos veces.

* **Los pasos que ejecuta:**
  * **Paso 1 (Idempotencia interna):**
    Ejecuta una consulta agrupada sobre la tabla `transfers`:
    ```sql
    SELECT idempotency_key, count(*)::int as count, max(id) as sample_id, max(account_id) as account_id, max(amount_cents)::bigint as amount_cents
    FROM transfers
    WHERE idempotency_key IS NOT NULL
    GROUP BY idempotency_key
    HAVING count(*) > 1
    ```
    Si `count > 1`, significa que el filtro de idempotencia falló y se crearon múltiples registros para la misma orden del cliente.
  * **Paso 2 (Envíos al proveedor bancario):**
    Revisa en memoria el registro `provider.submissions` (los pagos aceptados por el banco).
    Usa un `Map<string, number>` como contador de frecuencias: si para un mismo `transfer_id` el banco tiene `count > 1`, significa que el banco procesó el pago más de una vez.
  * **Cálculo del Impacto Financiero:**
    `Impacto = monto * (repeticiones - 1)`. Si la orden era de $500 y se procesó 2 veces, hay exactamente $500 USD cobrados de más.
  * **Severidad:** 🔴 `CRITICAL`.
  * **Acción recomendada:** Verificar si el dinero salió físicamente del banco y solicitar la devolución/recall bancario inmediato.

---

#### 2. `checkLedgerInvariants(db)` ➔ Integridad del Libro Contable (Ticket 203)

* **Qué busca en el negocio:**
  Violaciones a las leyes matemáticas del dinero en el libro mayor (`ledger_entries`). El libro contable nunca puede duplicar movimientos ni permitir que un cliente gaste más dinero del que tiene.

* **Los pasos que ejecuta:**
  * **Paso 1 (Doble Release - Ticket 203):**
    Consulta en `ledger_entries` si alguna transferencia tiene más de una fila con `entry_type = 'release'`:
    ```sql
    SELECT transfer_id, count(*)::int as count, max(amount_cents)::bigint as amount_cents
    FROM ledger_entries
    WHERE entry_type = 'release' AND transfer_id IS NOT NULL
    GROUP BY transfer_id HAVING count(*) > 1
    ```
    *Por qué es crítico:* Como cada `release` suma saldo disponible (`+`), meter dos releases contra un solo `hold` le **regala dinero fantasma al cliente**.
  * **Paso 2 (Doble Debit):**
    Consulta si alguna transferencia tiene más de una fila con `entry_type = 'debit'`. Si tiene 2 débitos, le quitamos el doble de plata al cliente.
  * **Paso 3 (Saldo Negativo / Sobregiro):**
    Recorre las cuentas de la tabla `accounts` y calcula el saldo disponible en tiempo real con `availableCents(db, acc.id)`. Si el saldo es `< 0`, significa que la cuenta cayó en descubierto (sobregiro involuntario).
  * **Cálculo del Impacto Financiero:**
    Suma el saldo inflado artificialmente, el débito excedente o el monto total del descubierto.
  * **Severidad:** 🔴 `CRITICAL`.
  * **Acción recomendada:** Revertir los asientos duplicados en el ledger antes de que el cliente retire los fondos inflados.

---

#### 3. `checkStrandedFunds(db)` ➔ Fondos Retenidos Varados (Ticket 202)

* **Qué busca en el negocio:**
  Dinero del cliente que quedó "secuestrado" injustamente. Ocurre cuando un pago fue rechazado o reversado por el banco, pero en nuestro sistema nadie le descongeló la plata al cliente.

* **Los pasos que ejecuta:**
  * **Paso 1 (Búsqueda cruzada de Hold sin Release):**
    Lanza una consulta con `EXISTS` y `NOT EXISTS`:
    ```sql
    SELECT t.id, t.account_id, t.amount_cents, t.fee_cents, t.status, t.idempotency_key
    FROM transfers t
    WHERE t.status IN ('reversed', 'failed', 'returned')
      AND EXISTS (SELECT 1 FROM ledger_entries le WHERE le.transfer_id = t.id AND le.entry_type = 'hold')
      AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.transfer_id = t.id AND le.entry_type = 'release')
    ```
    Traducido al español: *"Trae las transferencias que ya terminaron en fallo (`reversed`, `failed`, `returned`), que sí tienen un `hold` de congelación, pero donde NUNCA se registró el `release`"*.
  * **Cálculo del Impacto Financiero:**
    `Impacto = amount_cents + fee_cents` (el monto del pago más la comisión retenida).
  * **Severidad:** 🟠 `HIGH`.
  * **Acción recomendada:** Publicar de inmediato un asiento contable de tipo `'release'` en `ledger_entries` por el monto total para que el cliente recupere su saldo disponible.

---

#### 4. `checkStuckTransfers(db)` ➔ Transferencias Atascadas u Huérfanas (Ticket 204)

* **Qué busca en el negocio:**
  Órdenes de pago que quedaron en un "limbo" operativo y que jamás van a llegar al banco ni se van a resolver por sí solas:
  1. *Transferencias huérfanas sin Outbox:* Creadas en la base de datos pero cuyo proceso se cayó antes de encolar en la tabla outbox (el fallo del Ticket 204).
  2. *Tareas con reintentos agotados (Dead-Letter Queue):* Tareas que el worker intentó enviar pero fallaron 3 o más veces.

* **Los pasos que ejecuta:**
  * **Paso 1 (Transferencias huérfanas):**
    Busca transferencias en estado `'created'` que no tengan ninguna fila en la tabla `outbox`:
    ```sql
    SELECT t.id, t.account_id, t.amount_cents, t.fee_cents, t.status, t.idempotency_key
    FROM transfers t
    WHERE t.status = 'created'
      AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.transfer_id = t.id)
    ```
    Como el worker en segundo plano solo lee la tabla `outbox`, estas órdenes son invisibles para él: el dinero queda retenido y nadie lo enviará al banco.
  * **Paso 2 (Tareas agotadas en Outbox):**
    Consulta tareas con `attempts >= 3` y `status != 'processed'`. Muestra el último error registrado para saber si el banco se cayó o el payload era inválido.
  * **Cálculo del Impacto Financiero:**
    El monto total de las órdenes atascadas que están en espera de despacho.
  * **Severidad:** 🟠 `HIGH`.
  * **Acción recomendada:** Insertar manualmente la tarea en outbox si es huérfana, o revisar la conectividad bancaria y reiniciar intentos.

---

#### 5. `checkReconciliationDrift(db)` ➔ Descuadre con el Extracto Bancario (Ticket 206)

* **Qué busca en el negocio:**
  Diferencias entre lo que nuestro sistema dice que pagó y lo que el extracto del banco dice que realmente cobró al cierre del día.

* **Los pasos que ejecuta:**
  * **Paso 1 (Conciliación general):**
    Ejecuta `reconcile(db)`, que cruza las transferencias en estado `settled` contra `provider.statement()`.
  * **Paso 2 (Diferencia neta `diffCents`):**
    Si `diffCents !== 0`, levanta una anomalía `HIGH` informando cuántos dólares hay de desfase entre nuestro libro mayor y el banco.
  * **Paso 3 (Descuadre de tarifas `feeMismatches` - Ticket 206):**
    Si la lista `r.feeMismatches` tiene elementos, reporta las órdenes donde la comisión calculada por Kira no coincide con la del banco (por ejemplo, el problema de truncamiento vs redondeo *Round Half-Up*).
  * **Paso 4 (Pagos solo en extracto `statementOnly`):**
    Reporta si en el banco aparecen transacciones que no existen en nuestro sistema (por ejemplo, pagos duplicados por timeout del Ticket 205).
  * **Cálculo del Impacto Financiero:**
    La diferencia neta en centavos (`|diffCents|`) o la suma de comisiones desfasadas.
  * **Severidad:** 🟡 `MEDIUM` / 🟠 `HIGH`.
  * **Acción recomendada:** Ajustar la fórmula de comisiones en `money.ts` o auditar movimientos huérfanos antes del cierre contable diario.

---

### 9.3 Resumen de las 5 Funciones de Triaje

| Función | Qué busca | Severidad | Ticket Relacionado |
| :--- | :--- | :---: | :---: |
| **`checkDuplicatePayouts`** | Idempotencias repetidas en transfers o envíos duplicados al proveedor. | 🔴 `CRITICAL` | 201 y 205 |
| **`checkLedgerInvariants`** | Múltiples releases (saldo inflado), múltiples débitos o saldo negativo. | 🔴 `CRITICAL` | 203 |
| **`checkStrandedFunds`** | Transferencias en `reversed`/`failed` que conservan el hold sin release. | 🟠 `HIGH` | 202 |
| **`checkStuckTransfers`** | Transferencias `created` sin outbox (crash) o tareas con `attempts >= 3`. | 🟠 `HIGH` | 204 |
| **`checkReconciliationDrift`**| `diffCents != 0`, tarifas dispares o transacciones solo en el extracto. | 🟡 `MEDIUM` | 206 |

---

## 10. La Nota de Incidente al Cliente y Comunicación FinTech (Entregable 4)

### 10.1 Los 5 Pilares de la Comunicación en Incidentes Financieros

Cuando un cliente como **Marea Pay S.A.** experimenta un incidente crítico (como el doble cobro y doble pago a su proveedor del Ticket 201), el rol de un **Integration Engineer** no es solo arreglar el código en GitHub, sino **dar la cara con calma, empatía y autoridad técnica**.

En la vida real y en la entrevista de *Client Roleplay*, una comunicación exitosa sigue 5 pilares inquebrantables:

1. **Empatía Inmediata y Cero Evasivas:**
   * Nunca empezar con excusas como *"Es que el cliente mandó dos llamadas"*.
   * El cliente tenía un timeout y su librería reintentó correctamente con el mismo `Idempotency-Key`. El fallo fue **100% de nuestra plataforma** por no manejar la concurrencia a nivel de base de datos. Asumir la responsabilidad genera confianza inmediata.
2. **Tranquilidad Financiera Primero (El Dinero):**
   * Antes de explicar código o PostgreSQL, al cliente lo único que le importa es: *«¿Dónde está mi plata y quién paga los $500 de más?»*.
   * Se le aclara de entrada: *«Kira ya acreditó los $514.50 USD de vuelta a su cuenta virtual. Su saldo está 100% restablecido y Marea Pay asume cero pérdida económica. Nosotros gestionamos el recall con el banco destinatario»*.
3. **Causa Raíz Explicada con Sencillez (*Clear RCA*):**
   * Explicar el concepto de **condición de carrera**: *"Ambas peticiones entraron en la misma fracción de milisegundo antes de que la primera quedara sellada en disco, creando dos órdenes paralelas"*.
4. **Solución Permanente de Arquitectura (*Permanent Fix*):**
   * Explicar que se aplicó una restricción de unicidad estricta en la base de datos (`UNIQUE constraint`) y una transacción atómica con captura de colisiones. Si vuelven a entrar dos peticiones idénticas, la segunda se devuelve de inmediato sin tocar el saldo ni llamar al banco.
5. **Garantía y Prevención (*Preventative Measures*):**
   * Pruebas de concurrencia automatizadas en CI y el nuevo monitor operativo de triaje en vivo.

---

### 10.2 Estructura del Documento `INCIDENT_NOTE.md`

El archivo [INCIDENT_NOTE.md](file:///c:/Users/joshu/OneDrive/Escritorio/Dev/Prueba%20Tecnica%20-%20Kira/kira-integration-trial-repo/INCIDENT_NOTE.md) contiene la versión oficial bilingüe:

* **Versión en Inglés (EN):** Con tono corporativo formal de FinTech internacional (estilo Stripe / Ramp / Brex), apto para el equipo técnico y directivo de Marea Pay en EE.UU.
* **Versión en Español (ES):** Adaptación profesional en español financiero, ideal para el equipo de operaciones local.

