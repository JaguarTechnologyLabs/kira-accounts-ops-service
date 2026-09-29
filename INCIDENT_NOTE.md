# Incident Resolution Note / Nota de Resolución de Incidente

**Incident Reference:** `INC-2026-09-CID-201`  
**Client:** Marea Pay S.A. (`ACC-MAREA`)  
**Affected Service:** Kira Accounts Ops Service — Outbound Transfers API  
**Severity:** High (Severity 1 — Unintended Payout Execution)  
**Status:** Resolved & Permanently Hardened  
**Date:** September 28, 2026  

---

# English Version

## 1. Executive Summary
On September 28, 2026, Marea Pay S.A. initiated an outbound payout request of **$500.00 USD** (plus a platform fee of **$14.50 USD**) intended for an external vendor. Due to an upstream network timeout on the client integration side, your client library automatically re-transmitted the payout request carrying the identical idempotency key (`idem-201`).

Owing to an application-level race condition in our transfer ingestion pipeline, both HTTP requests were processed concurrently within the same sub-millisecond execution window before a database lock could be acquired. Consequently, two distinct transfer instructions (`TX-0001` and `TX-0002`) were accepted, resulting in two separate provider settlement disbursements ($1,000.00 total) to the beneficiary and a duplicate deduction of $514.50 from Marea Pay's virtual account balance.

**Current Status:** The duplicate debit on your account has been fully reversed and refunded. The technical vulnerability in our API has been patched and validated with automated concurrency regression testing.

---

## 2. Customer Financial Impact & Account Balance
* **Authorized Transaction:** 1 payout of $500.00 USD + $14.50 platform fee ($514.50 USD).
* **Erroneous Duplicate Payout:** 1 additional payout of $500.00 USD + $14.50 platform fee ($514.50 USD).
* **Immediate Financial Adjustment:**
  * Kira has issued an immediate compensatory credit of **$514.50 USD** directly to Marea Pay's available ledger balance (`ACC-MAREA`), restoring your account to its exact expected position.
  * Kira is coordinating directly with the downstream banking rail provider to reclaim the overpaid $500.00 USD from the recipient's institution. **Marea Pay bears zero liability or loss for the overpaid funds.**

---

## 3. Root Cause Analysis (RCA)
Our technical investigation identified that the failure was caused by a **non-atomic "read-then-write" pattern coupled with the absence of a database-level uniqueness constraint**:

1. **Pre-check Latency:** When an API request reached `/transfers`, the server executed an initial query (`SELECT ... WHERE idempotency_key = $1`) to determine whether the key already existed.
2. **Concurrent Collision:** Because the client retry arrived while the initial request was still in-flight, both parallel threads observed zero existing records.
3. **Missing Persistence Constraint:** The PostgreSQL `transfers` table schema lacked a `UNIQUE` constraint on the `idempotency_key` column. As a result, both database `INSERT` operations succeeded simultaneously, assigning distinct internal IDs.
4. **Downstream Execution:** With two valid transfer rows registered, the system posted two ledger `hold` entries and enqueued two separate dispatch instructions into the `outbox` queue, which our background worker submitted to the external banking rail.

---

## 4. Corrective Actions & Permanent Architectural Fix
To guarantee that duplicate payouts can never recur under any concurrency or retry pattern, our engineering team deployed the following enhancements:

1. **Database-Level ACID Invariant:**
   * Enforced an immutable `UNIQUE` constraint on `transfers(idempotency_key)` directly in the relational schema (`src/db.ts`).
   * This guarantees that only one transaction can ever claim a given idempotency key at the persistence layer, regardless of thread count, server clustering, or millisecond race conditions.
2. **Atomic Collision Recovery:**
   * In `src/transfers.ts`, the transfer creation pipeline is now enclosed in an atomic database transaction (`db.transaction`).
   * If a concurrent retry collides at the database level, PostgreSQL raises a unique violation error (`23505`). Our application intercepts this collision, queries the winning transfer record, and returns the original transaction payload immediately.
   * Crucially, the losing thread is aborted before executing any ledger `hold` or enqueuing any `outbox` event, guaranteeing zero financial side-effects.
3. **End-to-End Idempotency Propagation:**
   * The unique internal transfer ID is now propagated downstream to the external banking rails as an idempotency key (`provider.submit(t, t.id)`), ensuring that even network timeouts between Kira and the banking provider cannot trigger duplicate disbursements.

---

## 5. Preventative Measures & Long-Term Hardening
* **Automated Concurrency Regression Suite:** Implemented test cases in our continuous integration (CI) pipeline simulating parallel requests over identical idempotency keys using `Promise.all`. Builds will fail if multiple transfers or ledger entries are created.
* **Ops Triage Monitor Deployment:** Implemented an automated operational health monitor (`GET /ops/triage`) that continuously audits internal transfers against external provider submissions to detect and alarm on any duplicate payout within seconds.
* **Service Level Guarantee:** We reaffirm our commitment that Marea Pay S.A.'s integrations remain protected by strict end-to-end idempotency standards across all payment rails.

---

# Versión en Español

## 1. Resumen Ejecutivo
El 28 de septiembre de 2026, Marea Pay S.A. emitió una orden de transferencia saliente por valor de **$500.00 USD** (más una comisión de plataforma de **$14.50 USD**) con destino a un proveedor en Estados Unidos. Debido a una interrupción transitoria de red en el cliente, la librería de integración reintentó automáticamente el envío transmitiendo la misma clave de idempotencia (`idem-201`).

Debido a una condición de carrera (*race condition*) en nuestro servicio de procesamiento, ambas peticiones fueron procesadas de forma paralela en la misma fracción de milisegundo antes de que se completara el registro en disco. En consecuencia, el sistema registró dos transferencias independientes (`TX-0001` y `TX-0002`), provocando el envío de dos giros reales de $500.00 USD al beneficiario y un débito duplicado de $514.50 USD en el saldo disponible de Marea Pay.

**Estado Actual:** El débito duplicado ha sido completamente reversado y acreditado a su favor. La vulnerabilidad técnica en nuestra API fue corregida de raíz y asegurada con pruebas automatizadas de regresión.

---

## 2. Impacto Financiero y Conciliación de Cuenta
* **Operación Autorizada:** 1 transferencia de $500.00 USD + $14.50 USD de tarifa ($514.50 USD).
* **Operación Duplicada No Intencionada:** 1 giro adicional de $500.00 USD + $14.50 USD de tarifa ($514.50 USD).
* **Acciones Contables Inmediatas:**
  * Kira aplicó un crédito compensatorio inmediato por **$514.50 USD** directamente en la cuenta virtual de Marea Pay (`ACC-MAREA`), restableciendo su saldo disponible al 100%.
  * Kira asumió directamente la gestión de recuperación de los fondos excedentes con la entidad bancaria del destinatario. **Marea Pay S.A. no asume ninguna responsabilidad ni pérdida económica por este incidente.**

---

## 3. Análisis de Causa Raíz (*Root Cause Analysis*)
La investigación técnica determinó que el incidente fue provocado por un patrón de lectura previa no atómico combinado con la ausencia de una restricción de unicidad en la base de datos:

1. **Lectura Previa Vulnerable:** Al recibir la solicitud en `/transfers`, el servicio realizaba una consulta previa (`SELECT ... WHERE idempotency_key = $1`) para verificar si la orden ya existía.
2. **Colisión Concurrente:** Al ingresar el reintento casi simultáneamente, ambas peticiones leyeron que la clave aún no existía en la base de datos.
3. **Falta de Constraint Relacional:** La tabla `transfers` en PostgreSQL no poseía una restricción `UNIQUE` en la columna `idempotency_key`. Por lo tanto, ambas operaciones de `INSERT` fueron aceptadas por el motor de base de datos de manera independiente.
4. **Ejecución en Rieles Externos:** Al persistirse dos órdenes válidas, el sistema emitió dos retenciones contables (`hold`) y encoló dos tareas en la tabla `outbox`, las cuales nuestro despachador envió al banco aliado.

---

## 4. Corrección Técnica Definitiva
Para erradicar por completo este escenario bajo cualquier volumen de concurrencia o reintentos de red, nuestro equipo de ingeniería implementó las siguientes mejoras:

1. **Restricción de Unicidad en Base de Datos (Garantía ACID):**
   * Se aplicó la restricción obligatoria `idempotency_key text UNIQUE` directamente en el esquema relacional (`src/db.ts`).
   * A nivel físico de base de datos es imposible que existan dos registros con la misma clave de idempotencia, independientemente de la cantidad de hilos o servidores distribuidos.
2. **Manejo Atómico de Colisiones y Transaccionalidad:**
   * En `src/transfers.ts`, todo el flujo de creación se integró en una transacción atómica (`db.transaction`).
   * Si una segunda petición colisiona concurrentemente, PostgreSQL rechaza la operación con código de error de duplicidad (`23505`). Nuestra aplicación captura la colisión, recupera la orden original ganadora y la devuelve inmediatamente al cliente sin ejecutar retenciones contables ni tareas en la outbox.
3. **Propagación de Idempotencia de Extremo a Extremo:**
   * El identificador interno inmutable de la transferencia (`t.id`) se propaga ahora al banco aliado (`provider.submit(t, t.id)`), garantizando que incluso ante caídas de red entre Kira y el banco, el dinero nunca pueda ser transferido dos veces.

---

## 5. Medidas Preventivas y Monitoreo Continuo
* **Pruebas Automatizadas de Concurrencia:** Incorporamos pruebas de estrés en nuestra suite de integración continua (CI) que disparan peticiones concurrentes mediante `Promise.all` validando que el saldo y los débitos permanezcan inalterados.
* **Monitor Operativo de Triaje en Vivo:** Desarrollamos un monitor de detección de anomalías (`GET /ops/triage`) que audita continuamente el libro mayor y los envíos al banco para alertar y mitigar cualquier desviación operativa en segundos.

---

### Contacto de Soporte Técnico Especializado
Si su equipo de ingeniería requiere soporte adicional o detalles de telemetría de este evento, pueden contactar directamente a nuestro equipo de Integraciones en `integrations-support@kira.internal` referenciando el código `INC-2026-09-CID-201`.
