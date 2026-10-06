FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client python3 libicu74 libssl3t64 zlib1g tar gzip \
    && rm -rf /var/lib/apt/lists/* && useradd -m -u 1001 runner
WORKDIR /home/runner/actions
# Official release checksum: https://github.com/actions/runner/releases/tag/v2.337.0
RUN curl -fsSL https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-linux-x64-2.337.0.tar.gz -o /tmp/runner.tar.gz \
    && echo '70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613  /tmp/runner.tar.gz' | sha256sum -c - \
    && tar xzf /tmp/runner.tar.gz && rm /tmp/runner.tar.gz && chown -R runner:runner /home/runner/actions
COPY infra/ec2/runner/entrypoint.sh /usr/local/bin/start-runner
RUN chmod +x /usr/local/bin/start-runner
USER runner
ENTRYPOINT ["/usr/local/bin/start-runner"]
