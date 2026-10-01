#!/bin/sh
# Apply pending Prisma migrations (into the `public` schema from DATABASE_URL), then start the app.
set -e
echo "Applying database migrations…"
./node_modules/.bin/prisma migrate deploy
exec "$@"
