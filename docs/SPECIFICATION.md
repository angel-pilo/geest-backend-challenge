# Especificación técnica

Contrato derivado del PDF autoritativo del reto GEEST. La única mejora de producto es el historial de actividad.

## Endpoints

| Método | Ruta | Éxito |
| --- | --- | --- |
| POST | `/users` | `201`, usuario con ID |
| POST | `/tasks` | `201`, tarea `open` con ID |
| POST | `/tasks/:idTask/assign` | `200`, asignación atómica |
| POST | `/tasks/:idTask/complete` | `200`, participación y estado resultante |
| GET | `/tasks?status=open|archived` | `200`, tareas con usuarios y finalización |
| GET | `/users` | `200`, usuarios con tareas abiertas pendientes |
| GET | `/users/:idUser/tasks` | `200`, tareas y finalización del usuario |
| GET | `/tasks/:idTask` | `200`, detalle y usuarios asignados |
| GET | `/tasks/:idTask/notifications` | `200`, estado del trabajo e intentos |
| GET | `/tasks/:idTask/history` | `200`, eventos de actividad |

`POST /users` acepta `{ "name", "lastName", "email" }`; los tres campos son obligatorios y el email debe ser válido. `POST /tasks` acepta `{ "title", "description?" }`; solo el título es obligatorio. Asignación acepta `{ "userIds": [1, 2] }` y finalización `{ "userId": 1 }`.

Las tareas se representan con `id`, `title`, `description`, `status`, `archivedAt`, `createdAt` y, en consultas completas, `assignedUsers`. Cada usuario asignado incluye datos básicos, `assignedAt`, `completed` y `completedAt`. Las tareas por usuario incluyen esos mismos estados desde la perspectiva del usuario.

## Errores

Toda respuesta de error tiene exactamente:

```json
{"error":{"code":"TASK_NOT_FOUND","message":"Task not found"}}
```

Códigos usados: `VALIDATION_ERROR` (`400`), `INVALID_JSON` (`400`), `INVALID_IDEMPOTENCY_KEY` (`400`), `USER_NOT_FOUND` (`404`), `TASK_NOT_FOUND` (`404`), `ROUTE_NOT_FOUND` (`404`), `IDEMPOTENCY_CONFLICT` (`409`), `USER_NOT_ASSIGNED` (`409`), `TASK_ARCHIVED` (`409`) e `INTERNAL_SERVER_ERROR` (`500`).

## Idempotencia y concurrencia

Todos los POST aceptan `Idempotency-Key` opcional, máximo 255 caracteres. Su identidad es clave + método + ruta concreta. El body se canonicaliza y se almacena mediante SHA-256. La misma identidad/body reproduce el status y JSON almacenados; un body distinto devuelve `409 IDEMPOTENCY_CONFLICT`.

La exclusión se obtiene con un bloqueo asesor transaccional de PostgreSQL. La operación, sus eventos y la respuesta idempotente se confirman en una sola transacción. Las asignaciones bloquean la tarea, validan todos los usuarios y usan la clave `(task_id, user_id)`; no puede existir una asignación parcial o duplicada.

La finalización bloquea la tarea y participación. Si quedan pendientes continúa `open`; si no, actualiza a `archived`, fija `archived_at`, crea un evento de archivo y un único `notification_job`. Dos finalizaciones concurrentes quedan serializadas por tarea.

## Notificaciones

Al archivar se agenda un POST a `NOTIFY_URL`:

```json
{"taskId":123,"title":"Título","archivedAt":"2026-08-20T20:00:00.000Z"}
```

Un `2xx` marca éxito. Conexión, timeout o `5xx` se reintentan con esperas exponenciales hasta tres intentos; `4xx` falla sin reintento. El trabajador reclama filas con `FOR UPDATE SKIP LOCKED`, recupera reclamos abandonados y registra `attemptNumber`, `attemptedAt`, `httpStatus` nullable y `errorMessage` nullable. `/notifications` devuelve `{ taskId, status, attempts }`.

## Historial y supuestos

El historial devuelve `task_created`, `users_assigned`, `user_completed` y `task_archived`, con `userId`, metadata y timestamp. Solo registra cambios efectivos.

El email no es único. Una asignación con cualquier usuario inexistente falla completa. No se asigna a una tarea archivada. Repetir una finalización completada es éxito sin efectos nuevos. Las consultas se ordenan por ID/asignación y los eventos por timestamp/ID para respuestas deterministas.
