package com.flowlink.common.lifecycle

import org.springframework.http.HttpStatus
import org.springframework.stereotype.Component
import org.springframework.web.bind.annotation.ResponseStatus
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

/** 설치 준비와 새 실행의 경합을 막는다. 외부 호출은 끝날 때까지 work 안에 둔다. */
@Component
class RuntimeUpdateGate {
    private val lock = ReentrantReadWriteLock(true)
    @Volatile final var frozen: Boolean = false
        private set

    fun <T> work(action: () -> T): T = lock.read {
        if (frozen) throw UpdateInProgressException()
        action()
    }

    /** 기다리거나 강제 종료하지 않는다. 활동/대기 상태 확인에 실패하면 기존 앱을 유지한다. */
    fun freeze(check: () -> Unit) {
        val write = lock.writeLock()
        if (!write.tryLock()) throw UpdateInProgressException("처리 중인 요청이 있습니다. 완료된 후 설치하세요.")
        try {
            if (frozen) throw UpdateInProgressException()
            check()
            frozen = true
        } finally { write.unlock() }
    }

    fun resume() = lock.write { frozen = false }
}

@ResponseStatus(HttpStatus.SERVICE_UNAVAILABLE)
class UpdateInProgressException(message: String = "업데이트 설치를 준비 중입니다. 앱이 다시 열린 후 시도하세요.") : RuntimeException(message)
