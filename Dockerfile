FROM node:20-alpine

# Variables de entorno
ENV NODE_ENV=production

WORKDIR /app

# Copiamos solo dependencias primero (mejor cache)
COPY package*.json ./

# Instalamos solo prod deps
RUN npm ci --omit=dev

# Copiamos el resto del código
COPY . .

# Seguridad: no correr como root
USER node

EXPOSE 3000

CMD ["npm", "start"]