package com.flowlink.execution.config

import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

/** 작업마다 새 가상 스레드. 실행·대기 상한은 스레드 풀이 아닌 permit으로 유지한다. */
class BoundedVirtualExecutor(name: String, parallelism: Int, queueCapacity: Int) : AbstractExecutorService() {
    private val running: Semaphore
    private val capacity: Semaphore
    private val executor = Executors.newThreadPerTaskExecutor(Thread.ofVirtual().name(name, 0).inheritInheritableThreadLocals(false).factory())

    init {
        require(parallelism > 0 && queueCapacity >= 0)
        running = Semaphore(parallelism, true)
        capacity = Semaphore(Math.addExact(parallelism, queueCapacity))
    }

    override fun execute(command: Runnable) {
        if (!capacity.tryAcquire()) throw RejectedExecutionException("실행·대기 상한에 도달했습니다.")
        try {
            executor.execute {
                var acquired = false
                try {
                    running.acquire()
                    acquired = true
                    command.run()
                } catch (_: InterruptedException) {
                    if (command is Future<*>) command.cancel(false)
                    Thread.currentThread().interrupt()
                } finally {
                    if (acquired) running.release()
                    capacity.release()
                }
            }
        } catch (e: RuntimeException) {
            capacity.release()
            throw e
        }
    }

    override fun shutdown() = executor.shutdown()
    override fun shutdownNow(): List<Runnable> = executor.shutdownNow()
    override fun isShutdown(): Boolean = executor.isShutdown
    override fun isTerminated(): Boolean = executor.isTerminated
    override fun awaitTermination(timeout: Long, unit: TimeUnit): Boolean = executor.awaitTermination(timeout, unit)
}
