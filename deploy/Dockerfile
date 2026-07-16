# 실행 전용 이미지 — 빌드는 호스트에서: (frontend) npm run build → (backend) gradle bootJar
# 컨텍스트는 리포 루트: docker compose -f deploy/docker-compose.yml build
FROM eclipse-temurin:21-jre
WORKDIR /app
COPY backend/build/libs/flowlink.jar /app/flowlink.jar
EXPOSE 18080
ENTRYPOINT ["java", "-jar", "/app/flowlink.jar"]
