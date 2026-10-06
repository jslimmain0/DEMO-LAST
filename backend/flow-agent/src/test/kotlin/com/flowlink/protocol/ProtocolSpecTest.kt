package com.flowlink.protocol

import com.flowlink.protocol.ProtocolSpec.Field
import com.flowlink.protocol.ProtocolSpec.Message
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class ProtocolSpecTest {
    private fun spec(disc: String? = "거래코드", messages: List<Message> = listOf(
        Message("0210", "요청", listOf(Field("계좌번호", 13, "ascii"), Field("금액", 15, "numeric"))),
        Message("0211", "응답", listOf(Field("응답코드", 4, "ascii"))),
    )) = ProtocolSpec(
        encoding = "EUC-KR", lengthField = "전문길이", discriminator = disc,
        header = listOf(Field("전문길이", 4, "length"), Field("거래코드", 4, "ascii")), messages = messages,
    )

    @Test
    fun `헤더 길이와 전문 총 길이`() {
        val s = spec()
        assertThat(s.headerLen()).isEqualTo(8)
        assertThat(s.totalLen("0210")).isEqualTo(36)
        assertThat(s.lengthFieldOffset()).isEqualTo(0)
    }

    @Test
    fun `lookup - disc 값과 방향 복합키 우선, 없으면 disc 키`() {
        val s = spec(messages = listOf(Message("0210", null, emptyList()), Message("0210:response", null, listOf(Field("응답코드", 4, "ascii")))))
        assertThat(s.lookup("0210", Direction.RECV)?.key).isEqualTo("0210:response")
        assertThat(s.lookup("0210", Direction.SEND)?.key).isEqualTo("0210")
        assertThat(s.lookup("9999", Direction.RECV)).isNull()
        assertThat(s.discValueOf("0210:response")).isEqualTo("0210")
    }

    @Test
    fun `분기 없으면 request-response 키`() {
        val s = spec(disc = "", messages = listOf(Message("request", null, emptyList()), Message("response", null, emptyList())))
        assertThat(s.lookup(null, Direction.RECV)?.key).isEqualTo("response")
        assertThat(s.validate()).isEmpty()
        assertThat(spec(disc = "", messages = listOf(Message("0210", null, emptyList()))).validate()).anyMatch { it.contains("request/response") }
    }

    @Test
    fun `검증 - 길이 필드 타입, 분기 필드, 이름 중복, 길이 0`() {
        assertThat(spec().validate()).isEmpty()
        assertThat(spec().copy(lengthField = "없음").validate()).anyMatch { it.contains("없음") }
        assertThat(spec().copy(header = listOf(Field("전문길이", 4, "ascii"), Field("거래코드", 4, "ascii"))).validate()).anyMatch { it.contains("length") }
        assertThat(spec(disc = "구분").validate()).anyMatch { it.contains("구분") }
        assertThat(spec(messages = listOf(Message("0210", null, listOf(Field("a", 1, "ascii"), Field("a", 2, "ascii"))))).validate()).anyMatch { it.contains("중복") }
        assertThat(spec(messages = listOf(Message("0210", null, listOf(Field("a", 0, "ascii"))))).validate()).anyMatch { it.contains("길이") }
        assertThat(spec().copy(lengthFormat = "binary", header = listOf(Field("전문길이", 3, "length"), Field("거래코드", 4, "ascii"))).validate()).anyMatch { it.contains("1, 2, 4") }
        // 본문 필드가 헤더 필드와 같은 이름이면 값 맵이 모호해진다
        assertThat(spec(messages = listOf(Message("0210", null, listOf(Field("거래코드", 4, "ascii"))))).validate()).anyMatch { it.contains("헤더 필드와 이름이 겹칩니다") }
    }

    @Test
    fun `패딩 기본값은 타입별`() {
        assertThat(Field("a", 1, "numeric").padOr()).isEqualTo("left/zero")
        assertThat(Field("a", 1, "length").padOr()).isEqualTo("left/zero")
        assertThat(Field("a", 1, "string").padOr()).isEqualTo("right/space")
        assertThat(Field("a", 1, "binary").padOr()).isEqualTo("none")
        assertThat(Field("a", 1, "ascii", "left/space").padOr()).isEqualTo("left/space")
    }
}
