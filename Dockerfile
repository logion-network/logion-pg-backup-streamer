FROM node:16 AS build
WORKDIR /build
COPY . .
RUN yarn
RUN yarn build

FROM logionnetwork/logion-pg-backup-manager-base:latest
COPY --from=build /build/dist dist
COPY --from=build /build/node_modules node_modules

CMD node ./dist/index.js
