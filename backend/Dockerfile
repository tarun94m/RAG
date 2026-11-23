FROM node:20-slim
WORKDIR /app
# Optional corporate CA (see certs/README.txt). Also lets the API reach OpenAI behind the same proxy.
COPY certs/ /certs/
ENV NODE_EXTRA_CA_CERTS=/certs/corp-ca.pem
COPY package*.json .npmrc ./
RUN npm install --omit=dev --no-audit --no-fund --fetch-retries=2 --fetch-timeout=60000
COPY src ./src
EXPOSE 4000
CMD ["node", "src/index.js"]
