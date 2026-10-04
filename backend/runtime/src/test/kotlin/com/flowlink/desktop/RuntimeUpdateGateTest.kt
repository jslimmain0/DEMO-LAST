package com.flowlink.desktop

import com.flowlink.common.lifecycle.RuntimeUpdateGate
import com.flowlink.common.lifecycle.UpdateInProgressException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class RuntimeUpdateGateTest {
    @Test fun `install does not interrupt an external request and excludes later admissions`() {
        val gate = RuntimeUpdateGate()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val task = thread { gate.work { entered.countDown(); release.await(5, TimeUnit.SECONDS) } }
        try {
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            assertThrows(UpdateInProgressException::class.java) { gate.freeze { fail("activity check must not race a request") } }
            assertFalse(gate.frozen)
        } finally { release.countDown(); task.join(2000) }
        gate.freeze {}
        assertThrows(UpdateInProgressException::class.java) { gate.work { fail("new task admitted") } }
        gate.resume()
        assertEquals("ok", gate.work { "ok" })
    }

    @Test fun `waiting execution or failed check leaves app usable`() {
        val gate = RuntimeUpdateGate()
        assertThrows(IllegalStateException::class.java) { gate.freeze { error("WAITING") } }
        assertFalse(gate.frozen)
        assertTrue(gate.work { true })
    }

}
