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

### Resumen Comparativo de los Tickets

| Ticket | Síntoma Reportado | Causa Raíz (Bug) | Solución Técnica | Archivos Editados |
| :--- | :--- | :--- | :--- | :--- |
| **201** | Doble cobro y doble pago al destinatario en peticiones simultáneas con el mismo `Idempotency-Key`. | Falta de constraint `UNIQUE` en `transfers.idempotency_key` y patrón no atómico de lectura previa. | `UNIQUE` en esquema + captura de colisión PostgreSQL `23505` con retorno inmediato de la transferencia ganadora. | `db.ts`<br>`transfers.ts` |
| **202** | Pago cancelado/reversado por el proveedor queda en `submitted` y fondos congelados en la cuenta. | `applyProviderResult` no manejaba el estado `'reversed'` en su condicional de webhooks. | Añadida rama `'reversed'` que emite `release` en ledger y transiciona a estado terminal `reversed`. | `transfers.ts` |
| **203** | Pago exitoso en el banco aparece como `failed` en Kira y saldo del cliente queda sobregirado/inflado. | Webhooks fuera de orden (`settled` luego `failed`) sobreescribían estado terminal y emitían doble `release`. | Invariante de estado terminal (`settled` inmutable) + verificación de idempotencia en ledger (`!hasRelease`, `!hasDebit`). | `transfers.ts` |
| **204** | Servidor se cae a mitad de la petición: transferencia queda varada en `created` con fondos retenidos y nunca se procesa. | Operaciones no atómicas (3 `INSERT` independientes sin transacción). Si se cae el proceso antes de la outbox, la plata queda atrapada. | Transacción atómica `db.transaction` (o se crean transferencia + hold + outbox, o rollback total y fondos intactos). | `transfers.ts` |

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

### 2. Preguntas clave que me pueden hacer y cómo explicarlas

#### "¿Por qué no guardar el saldo en una columna `balance` y restarle directamente?"
* **Cómo lo explico:**
  * Porque en finanzas reales no puedes perder el rastro de la plata. Si alguien edita una columna de saldo directamente y hay un bug, no hay forma de saber qué pasó, ni a qué hora, ni por qué orden.
  * Con una tabla de movimientos inmutables (`ledger_entries`), el saldo siempre se calcula sumando y restando entradas históricas. Hay auditoría total segundo a segundo para conciliar con el banco al final del día.

#### "¿Por qué usamos una tabla `outbox` en vez de llamar al banco en el mismo endpoint?"
* **Cómo lo explico:**
  * Por velocidad y por caídas de red. Una llamada HTTP a un banco puede tardar 10 o 20 segundos; no podemos dejar al usuario esperando con la pantalla congelada.
  * Además, si se corta internet justo cuando el banco estaba cobrando, la API le tiraría un error 500 al cliente pero el dinero sí habría salido. Con el outbox, la orden queda anotada en milisegundos en la base de datos local y el worker se encarga de entregarla con reintentos seguros.

#### "¿Cómo evitamos el doble cobro por reintentos concurrentes (Ticket 201)?"
* **Cómo lo explico:**
  * El código anterior hacía un `SELECT` para ver si existía la clave de idempotencia y luego un `INSERT`. Pero en PostgreSQL la columna no tenía `UNIQUE`. Si el cliente sufría un timeout y mandaba dos peticiones en el mismo milisegundo, las dos leían que no existía y las dos creaban la transferencia.
  * Lo arreglé poniendo `idempotency_key text UNIQUE` en la base de datos y envolviendo el insert en un `try/catch`. Si la segunda petición choca contra el constraint (error `23505`), atrapamos el error y devolvemos de inmediato la transferencia ganadora sin volver a crear retenciones ni tareas en el outbox.

#### "¿Cómo controlamos webhooks desordenados y el riesgo de saldo duplicado (Ticket 203)?"
* **Cómo lo explico:**
  * El proveedor mandaba primero `settled` (éxito) y luego llegaba un `failed` tardío por retrasos de red. El código viejo sobreescribía el estado a `failed` y metía un segundo `release` en el ledger. Como cada release suma saldo, le estábamos regalando plata de la nada al cliente.
  * Lo resolví con dos reglas:
    1. **Estado terminal intocable:** Si en la base de datos ya está en `settled`, cualquier webhook tardío de fallo se ignora y se descarta de una.
    2. **Idempotencia contable:** Antes de meter filas en el ledger revisamos `hasDebit` y `hasRelease`. Una transferencia jamás puede tener más de un débito ni más de una liberación, sin importar cuántas veces llegue el webhook.

#### "¿Qué pasaba si el servidor se caía a mitad de la petición (Ticket 204)?"
* **Cómo lo explico:**
  * Crear la transferencia tenía **3 pasos secuenciales**: (1) guardar en `transfers` en estado `created`, (2) congelar la plata en el libro contable (`ledger_entries` con un `hold`), y (3) meter la tarea en la tabla `outbox` para que el worker la enviara al banco.
  * **El problema fatal:** Entre el paso 2 y el paso 3 podía ocurrir un error o caerse el servidor (corte de luz, crash de Node, timeout, etc.). Si el proceso moría ahí en la mitad:
    * La orden ya estaba guardada y la plata ya estaba congelada en la cuenta del cliente (pasos 1 y 2).
    * Pero como la tarea jamás llegó a la tabla `outbox` (paso 3), el worker nunca se enteraba y nunca enviaba el dinero al banco. La plata del cliente quedaba secuestrada en un limbo permanente.
  * **La solución:** Envolvemos los 3 pasos en una transacción atómica de base de datos (`db.transaction`). O se completan los 3 pasos juntos, o no se guarda ninguno. Si el servidor se cae entre el paso 2 y el paso 3, la base de datos ejecuta un `ROLLBACK` automático: se borra el hold y se borra la transferencia, dejando el saldo del cliente 100% intacto y disponible para reintentar.

#### "¿Cuál es la diferencia entre `db` y `tx` en el código?"
* **Cómo lo explico:**
  * `db` es la **instancia global de la base de datos**. Representa el motor completo o el pool de conexiones. Cualquier consulta que hagas con `db.query()` se ejecuta por fuera de cualquier transacción aislada o compite directamente en la conexión.
  * `tx` es el **objeto de la transacción activa**. Nace únicamente dentro de `db.transaction(async (tx) => { ... })` y representa una sesión protegida y atómica:
    1. **Aislamiento:** Todo lo que ejecutas con `tx.query()` está temporalmente dentro de esa burbuja transaccional. Nada de lo que hagas ahí dentro es visible para el resto del mundo hasta que la función retorne exitosamente (`COMMIT`).
    2. **Rollback automático en caso de fallo:** Si ocurre un error o un crash adentro, `db.transaction` cancela esa burbuja (`ROLLBACK`), deshaciendo cualquier `tx.query()` que se haya ejecutado.
    3. **Mutex / Candado de concurrencia en PGlite:** En una base de datos en memoria como PGlite (que tiene una sola conexión compartida), `db.transaction` pone un candado (mutex) para atender las transacciones una por una. Si dos peticiones llegan al mismo milisegundo, la primera entra con su `tx`, y la segunda espera en fila. Así evitamos que dos `BEGIN` se choquen y corrompan la conexión.
  * **Regla de oro:** Si estás dentro de `db.transaction`, **siempre debes usar `tx.query()` o pasar `tx` a las funciones auxiliares (como `post(tx, ...)` o `getByIdemKey(tx, ...)`).** Si usaras `db` por error dentro de la transacción, te saldrías de la burbuja y podrías bloquear o abortar la conexión.

---

### 3. Glosario rápido para tener los términos claros

* **Virtual Account:** Cuenta digital en dólares que le abrimos a empresas como Marea Pay para mover plata sin necesidad de tener cuenta física en EE.UU.
* **ACH:** Red de transferencias bancarias de EE.UU. Tarda de 1 a 2 días hábiles en compensar.
* **Crypto Rail:** Pagos con stablecoins (USDC) que liquidan en minutos en la blockchain.
* **Hold:** Bloqueo preventivo de saldo. No le quita la plata todavía al cliente, pero no lo deja gastársela mientras el banco procesa.
* **Release:** Desbloqueo del hold. Si el pago fue exitoso, se quita el hold y se debita la plata real. Si el pago falló, solo se quita el hold para que la plata vuelva a estar disponible.
* **Settlement:** Cuando el dinero llegó efectivamente a la cuenta bancaria del destinatario final.
* **Reconciliation:** Cruzar las transferencias de nuestro sistema contra el extracto bancario del proveedor para verificar que no falte ni sobre un solo centavo.




