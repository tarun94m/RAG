FROM node:20-slim AS build
WORKDIR /app
# Optional corporate CA (see certs/README.txt). Ignored if the file is absent.
COPY certs/ /certs/
ENV NODE_EXTRA_CA_CERTS=/certs/corp-ca.pem
COPY package*.json ./
RUN npm install --no-audit --no-fund --fetch-retries=2 --fetch-timeout=60000
COPY . .
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
