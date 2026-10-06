package com.flowlink.execution.config

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.concurrent.CountDownLatch
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class BoundedVirtualExecutorTest {
    @Test fun `새 가상 스레드로 실행하며 동시 실행과 대기 상한을 지킨다`() {
        val executor = BoundedVirtualExecutor("check-", 1, 1)
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val calls = AtomicInteger()
        val local = InheritableThreadLocal<String>().apply { set("request-only") }
        try {
            val first = executor.submit<Boolean> {
                assertThat(local.get()).isNull()
                calls.incrementAndGet(); entered.countDown()
                release.await(3, TimeUnit.SECONDS)
                Thread.currentThread().isVirtual
            }
            assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue()
            val second = executor.submit<Boolean> { calls.incrementAndGet(); Thread.currentThread().isVirtual }
            assertThrows<RejectedExecutionException> { executor.execute { error("상한 초과 작업이 실행됨") } }
            assertThat(calls.get()).isEqualTo(1)
            release.countDown()
            assertThat(first.get(3, TimeUnit.SECONDS)).isTrue()
            assertThat(second.get(3, TimeUnit.SECONDS)).isTrue()
            executor.shutdown()
            assertThat(executor.awaitTermination(3, TimeUnit.SECONDS)).isTrue()
            assertThrows<RejectedExecutionException> { executor.execute {} }
        } finally { release.countDown(); local.remove(); executor.shutdownNow() }
    }

    @Test fun `종료 시 실행과 permit 대기를 인터럽트하고 대기 Future를 취소한다`() {
        val executor = BoundedVirtualExecutor("stop-", 1, 1)
        val entered = CountDownLatch(1)
        try {
            executor.execute { entered.countDown(); CountDownLatch(1).await() }
            assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue()
            val pending = executor.submit { error("종료한 대기 작업이 실행됨") }
            executor.shutdownNow()
            assertThat(executor.awaitTermination(3, TimeUnit.SECONDS)).isTrue()
            assertThat(pending.isCancelled).isTrue()
        } finally { executor.shutdownNow() }
    }
}
