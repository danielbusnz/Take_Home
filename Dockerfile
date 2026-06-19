# Plain Node image: the server connects to the Browserbase cloud browser over
# CDP, it never launches a local chromium, so no Playwright browser install or
# system libraries are needed here.
FROM node:22-slim
WORKDIR /app

# install deps first so this layer caches across code changes
COPY package*.json ./
RUN npm ci

COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
