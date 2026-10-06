# 격리된 EC2 배포 연습 서버. 호스트 Docker socket을 공유하지 않는다.
FROM docker:28.5.2-dind@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac

RUN apk add --no-cache bash openssh-server openssh-client curl ca-certificates coreutils util-linux python3 \
    && adduser -D -s /bin/bash flowlink \
    && addgroup flowlink docker \
    && passwd -d flowlink \
    && passwd -l root \
    && mkdir -p /home/flowlink/deploy /etc/ssh/keys /run/sshd \
    && chown flowlink:flowlink /home/flowlink /home/flowlink/deploy \
    && ln -s /home/flowlink/deploy /opt/flowlink \
    && docker compose version

COPY infra/ec2/entrypoint.sh /usr/local/bin/flowlink-ec2
RUN sed -i 's/\r$//' /usr/local/bin/flowlink-ec2 && chmod 755 /usr/local/bin/flowlink-ec2
ENV DOCKER_TLS_CERTDIR="" DOCKER_HOST=unix:///var/run/docker.sock
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/flowlink-ec2"]
