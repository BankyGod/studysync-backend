# StudySync database schema (documentation)

This folder is **documentation only**. It does not affect the running API or MongoDB.

| File | Purpose |
|------|---------|
| `studysync.dbml` | [DBML](https://www.dbml.org/) schema — tables, relationships, sample records |

## View the diagram

1. Open [dbdiagram.io](https://dbdiagram.io)
2. Paste the contents of `studysync.dbml`
3. Export as PNG/PDF if needed

## Source of truth in code

The live Mongoose schemas are in:

```
src/db/models.js
```

MongoDB database name is typically `studysync` (from your `MONGODB_URI`).
