# GEEST Backend Challenge

API REST para crear usuarios y tareas compartidas, completar participaciones individuales, archivar automáticamente una tarea cuando todos terminan y notificar a un sistema externo de forma confiable.

## Ejecución local

Todo el entorno puede ejecutarse en contenedores. Requiere Docker y Docker Compose:

```bash
docker compose up --build
```

Compose construye la API desde `Dockerfile`, inicia PostgreSQL 17, espera a que la base esté saludable y aplica las migraciones antes de servir en `http://localhost:3000`. Para detenerlo:

```bash
docker compose down
```

Para desarrollo fuera del contenedor se requiere Node.js 22 o superior. Copia `.env.example` como `.env`, inicia solo PostgreSQL con `docker compose up -d postgres` y ejecuta `npm ci`, `npm run db:migrate` y `npm run dev`. Validación completa:

```bash
npm run typecheck
npm run build
npm test
```

Las pruebas usan PostgreSQL real indicado por `DATABASE_URL`; antes de ejecutarlas deben haberse aplicado las migraciones. Los endpoints son:

| Método | Ruta |
| --- | --- |
| POST | `/users` |
| POST | `/tasks` |
| POST | `/tasks/:idTask/assign` |
| POST | `/tasks/:idTask/complete` |
| GET | `/tasks?status=open|archived` |
| GET | `/users` |
| GET | `/users/:idUser/tasks` |
| GET | `/tasks/:idTask` |
| GET | `/tasks/:idTask/notifications` |
| GET | `/tasks/:idTask/history` |

Todos los errores usan `{ "error": { "code": "...", "message": "..." } }`. Los contratos completos están en `docs/SPECIFICATION.md` y el UML en `docs/database-uml.puml`.

## Decisiones técnicas

- Express y TypeScript estricto; Zod valida cuerpos, parámetros y configuración.
- SQL directo con `pg`: las transacciones y bloqueos quedan explícitos, sin semántica oculta de ORM.
- PostgreSQL garantiza asignaciones únicas mediante clave primaria compuesta y un solo trabajo de notificación mediante `UNIQUE(task_id)`.
- Cada POST acepta `Idempotency-Key`. Un bloqueo asesor transaccional serializa la misma clave; la operación y su respuesta se guardan en la misma transacción. Repetir clave y body reproduce status/body; cambiar el body devuelve `409 IDEMPOTENCY_CONFLICT`.
- Completar una participación bloquea la tarea con `FOR UPDATE`. Así, dos últimos usuarios concurrentes producen un archivado, un evento y un trabajo lógico de notificación.
- El trabajador reclama trabajos con `FOR UPDATE SKIP LOCKED`. Reintenta conexión, timeout o `5xx` hasta tres veces con espera exponencial; un `4xx` se registra sin reintento. Cada intento conserva número, timestamp, status HTTP cuando existe y error.
- Las migraciones SQL versionan el esquema; Docker Compose reproduce PostgreSQL 17 localmente. El contenedor de producción migra antes de iniciar.

## Mejora única: historial de actividad

`GET /tasks/:idTask/history` resuelve la falta de trazabilidad en tareas compartidas: permite entender quién terminó, cuándo se asignó trabajo y cuándo se archivó. Era más necesaria que agregar búsqueda, autenticación o UI porque ayuda a diagnosticar concurrencia y operación sin alterar el flujo solicitado. Solo registra cambios efectivos, no replays idempotentes.

## Supuestos y alcance

- `Idempotency-Key` es opcional; si se envía, su alcance es método y ruta concreta. El body se compara de forma canónica, sin depender del orden de claves JSON.
- El email debe ser válido, pero no se exige unicidad. Una asignación falla completa si falta cualquier usuario; IDs repetidos o ya asignados no duplican relaciones.
- Repetir una finalización ya completada devuelve éxito sin efectos nuevos. No se asigna a tareas archivadas.
- `2xx` confirma una notificación; `4xx` es fallo definitivo; `5xx`, timeout y conexión son reintentables.
- No se recortó funcionalidad del reto. Deliberadamente no existen frontend, autenticación, roles, ORM ni panel administrativo.

## Repositorio y producción

Repositorio público: https://github.com/angel-pilo/geest-backend-challenge

API pública: https://geest-backend-challenge.onrender.com

La imagen de producción está definida en `Dockerfile` y `render.yaml` crea un servicio web más PostgreSQL administrado. Se eligió Render porque despliega el contenedor desde GitHub, entrega HTTPS y ofrece recursos gratuitos suficientes para la evaluación de siete días. Al usar el plan gratuito, la primera solicitud después de un periodo de inactividad puede tardar cerca de un minuto mientras inicia el contenedor.
