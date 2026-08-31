# GEEST Backend Challenge

API REST para gestionar usuarios, tareas compartidas, finalización individual y archivado automático. El objetivo técnico es mantener resultados correctos ante solicitudes duplicadas o concurrentes y registrar los intentos de notificación externa.

## Alcance

- Node.js con TypeScript y Express.
- PostgreSQL con migraciones SQL versionadas.
- Nueve endpoints obligatorios definidos por el reto.
- Idempotencia en todos los endpoints `POST`.
- Archivado y creación de notificación sin duplicados.
- Máximo tres intentos de notificación ante timeout o respuesta `5xx`.
- Tests unitarios y de integración.
- Mejora única: historial de actividad por tarea.

## Preparación local

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run dev
```

## Comandos

```bash
npm run typecheck
npm run build
npm test
```

La especificación de respuestas y supuestos está en `docs/SPECIFICATION.md`. El UML versionado se encuentra en `docs/database-uml.puml`.
