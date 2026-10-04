# FlowLink server runtime. The Windows MSI uses its own native Java/Node runtime.
FROM node:24-bookworm-slim AS node
FROM gradle:8.10.2-jdk21
USER root
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY backend/server-app/build/libs/flowlink-server.jar /app/flowlink.jar
COPY mcp/src /app/mcp/src
COPY mcp/package.json mcp/package-lock.json /app/mcp/
COPY mcp/node_modules /app/mcp/node_modules
USER gradle
ENTRYPOINT ["java", "-jar", "/app/flowlink.jar"]
