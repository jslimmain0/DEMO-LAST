# CI builds the JAR first; MCP and the server agent are hosted by this JVM.
FROM eclipse-temurin:21-jre-jammy
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1000 flowlink && useradd -m -u 1000 -g flowlink flowlink
WORKDIR /app
COPY backend/flow-server/build/libs/flowlink-server.jar /app/flowlink.jar
ENV HOME=/home/flowlink
USER flowlink
EXPOSE 18080
ENTRYPOINT ["java", "-jar", "/app/flowlink.jar"]
