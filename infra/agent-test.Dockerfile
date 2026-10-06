# FlowLink server runtime, including the central Kotlin MCP endpoint.
FROM gradle:8.10.2-jdk21
WORKDIR /app
COPY backend/flow-server/build/libs/flowlink-server.jar /app/flowlink.jar
USER gradle
ENTRYPOINT ["java", "-jar", "/app/flowlink.jar"]
