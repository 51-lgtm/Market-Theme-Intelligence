FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim AS node-runtime
WORKDIR /legacy
COPY package*.json ./
RUN npm ci --omit=dev

FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 ASTRA_HOST=0.0.0.0 PORT=8000
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY requirements.txt requirements-lock.txt ./
RUN node --version && pip install --no-cache-dir -r requirements.txt -c requirements-lock.txt && useradd --create-home astra
COPY --from=node-runtime /legacy/node_modules ./node_modules
COPY . .
COPY --from=frontend /build/dist ./frontend/dist
RUN mkdir -p /app/data && chown -R astra:astra /app
USER astra
EXPOSE 8000
CMD ["python", "run_astra.py"]
