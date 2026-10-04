package com.flowlink.desktop

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID

class DesktopDispatchJournalTest {
    @TempDir lateinit var directory: Path

    @Test fun `ACK 전 결과는 암호화 복구하고 처리 중 종료는 자동 재호출하지 않는다`() {
        val mapper = jacksonObjectMapper()
        DesktopSession(directory.toString(), 18180).use { session ->
            val journal = DesktopDispatchJournal(session, mapper)
            val completed = DesktopDispatchJournal.Entry(UUID.randomUUID(), true, "https://flowlink.example", "tester",
                taskId = "task-completed", phase = DesktopDispatchJournal.Phase.RESULT,
                result = mapper.readTree("""{"approval":"private-result","amount":42,"ok":true}"""))
            val executing = completed.copy(executionId = UUID.randomUUID(), taskId = "task-executing",
                phase = DesktopDispatchJournal.Phase.EXECUTING, result = null)
            journal.put(completed); journal.put(executing)
            assertThat(Files.readString(directory.resolve("dispatch-journal.enc")))
                .doesNotContain("private-result", "tester", "task-completed")

            val restored = DesktopDispatchJournal(session, mapper)
            assertThat(restored.get(completed.key)?.result?.get("amount")?.isInt).isTrue()
            assertThat(restored.get(completed.key)?.result?.get("approval")?.asText()).isEqualTo("private-result")
            assertThat(restored.get(executing.key)?.phase).isEqualTo(DesktopDispatchJournal.Phase.UNKNOWN)
            restored.remove(completed.key)
            assertThat(DesktopDispatchJournal(session, mapper).get(completed.key)).isNull()
            assertThat(Files.exists(directory.resolve("db"))).isFalse()
        }
    }
}
