# Especificación técnica

Este documento convierte el PDF del reto en un contrato verificable. No agrega funcionalidades de producto, excepto el historial solicitado como única mejora.

## Endpoints obligatorios

| Método | Ruta | Respuesta exitosa |
| --- | --- | --- |
| POST | `/users` | `201` con el usuario creado |
| POST | `/tasks` | `201` con la tarea creada en estado `open` |
| POST | `/tasks/:idTask/assign` | `200` con mensaje y usuarios asignados |
| POST | `/tasks/:idTask/complete` | `200` con mensaje y estado resultante |
| GET | `/tasks?status=open\|archived` | `200` con arreglo de tareas |
| GET | `/users` | `200` con usuarios y tareas pendientes |
| GET | `/users/:idUser/tasks` | `200` con las tareas del usuario |
| GET | `/tasks/:idTask` | `200` con el detalle de la tarea |
| GET | `/tasks/:idTask/notifications` | `200` con los intentos de notificación |

## Única mejora

`GET /tasks/:idTask/history` devuelve los eventos de creación, asignación, finalización y archivado de una tarea.

## Formato de error

```json
{
  "error": {
    "code": "TASK_NOT_FOUND",
    "message": "Task not found"
  }
}
```

## Supuestos documentados

1. `Idempotency-Key` es opcional. Cuando existe, su alcance es método y ruta.
2. Misma clave y mismo body devuelven el mismo status y JSON sin repetir la operación.
3. Misma clave y body diferente devuelve `409 IDEMPOTENCY_CONFLICT`.
4. El correo debe tener formato válido, pero no se exige que sea único.
5. Una asignación es atómica: si falta un usuario, no se asigna ninguno.
6. Los usuarios previamente asignados no se duplican.
7. No se agregan usuarios a una tarea archivada.
8. Repetir la finalización de una participación ya terminada devuelve éxito sin efectos adicionales.
9. Los errores de conexión, timeout y respuestas `5xx` se reintentan hasta completar tres intentos. Los `4xx` se registran sin reintento.
10. Una notificación lógica se representa con un solo `notification_job`; sus reintentos se registran como intentos separados.

## Contratos de respuesta

### Usuario creado

```json
{
  "id": 1,
  "name": "Angel",
  "lastName": "Aceves",
  "email": "angel@example.com"
}
```

### Tarea creada

```json
{
  "id": 1,
  "title": "Prepare report",
  "description": null,
  "status": "open",
  "archivedAt": null
}
```

### Asignación

```json
{
  "message": "Users assigned successfully",
  "taskId": 1,
  "assignedUserIds": [1, 2]
}
```

### Finalización

```json
{
  "message": "User task participation completed",
  "taskId": 1,
  "userId": 1,
  "taskStatus": "open",
  "archivedAt": null
}
```
