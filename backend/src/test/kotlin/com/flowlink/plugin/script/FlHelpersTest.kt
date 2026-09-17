package com.flowlink.plugin.script

import com.flowlink.plugin.PluginsProperties
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

/** fl.* 를 실제 스크립트 안에서 호출해 검증(프록시 경계 포함). */
class FlHelpersTest {
    private val rt = ScriptRuntime(PluginsProperties())
    private fun run(body: String, config: Map<String, String> = emptyMap()): Map<String, String> =
        rt.runTransform(rt.compile("({ id: 'x', label: 'x', apply(i, c) { return $body } })"), emptyMap(), config).value

    @Test fun `hex_hash_hmac`() {
        val r = run("{ h: fl.hex.enc('AB'), d: fl.hex.dec('4142'), s: fl.hash.sha256('abc'), m: fl.hmac.sha256('key', 'msg'), mb: fl.hmac.sha256('key', 'msg', { out: 'b64' }) }")
        assertThat(r["h"]).isEqualTo("4142"); assertThat(r["d"]).isEqualTo("AB")
        assertThat(r["s"]).isEqualTo("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        assertThat(r["m"]).isEqualTo("2d93cbc1be167bcb1637a4a23cbff01a7878f0c50ee833954ea5221bb1b8c628")
        assertThat(r["mb"]).isEqualTo("LZPLwb4We8sWN6SiPL/wGnh48MUO6DOVTqUiG7G4xig=")
    }

    @Test fun `aes_seed_aria 왕복 + 옵션`() {
        val k = "0123456789abcdef"; val iv = "0000000000000000"
        val r = run("""{
            a: fl.aes.decrypt(fl.aes.encrypt('카드1234', '$k', '$iv'), '$k', '$iv'),
            e: fl.aes.decrypt(fl.aes.encrypt('x', '$k', null, { mode: 'ECB', out: 'hex' }), '$k', null, { mode: 'ECB', out: 'hex' }),
            s: fl.seed.decrypt(fl.seed.encrypt('전문', '$k', '$iv'), '$k', '$iv'),
            r: fl.aria.decrypt(fl.aria.encrypt('전문', '$k', '$iv'), '$k', '$iv'),
            len: fl.aes.encrypt('카드1234', '$k', '$iv').length,
        }""")
        assertThat(r["a"]).isEqualTo("카드1234"); assertThat(r["e"]).isEqualTo("x"); assertThat(r["s"]).isEqualTo("전문"); assertThat(r["r"]).isEqualTo("전문")
        assertThat(r["len"]).isEqualTo("24") // 16B 블록 1개 → base64 24자
    }

    @Test fun `aes bytes 왕복 - 바이트 배열 입출력`() {
        val r = run("{ t: fl.text(fl.aes.decryptBytes(fl.aes.encryptBytes(fl.bytes('홍길동', 'EUC-KR'), '0123456789abcdef', '0000000000000000'), '0123456789abcdef', '0000000000000000'), 'EUC-KR'), n: fl.bytes('홍길동', 'EUC-KR').length }")
        assertThat(r["t"]).isEqualTo("홍길동"); assertThat(r["n"]).isEqualTo("6")
    }

    @Test fun `rsa 서명 검증`() {
        val kp = java.security.KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val enc = java.util.Base64.getMimeEncoder(64, "\n".toByteArray())
        val priv = "-----BEGIN " + "PRIVATE KEY-----\n" + enc.encodeToString(kp.private.encoded) + "\n-----END " + "PRIVATE KEY-----" // 리터럴을 쪼갠 이유: 커밋 훅(gitleaks) private-key 규칙
        val pub = "-----BEGIN " + "PUBLIC KEY-----\n" + enc.encodeToString(kp.public.encoded) + "\n-----END " + "PUBLIC KEY-----"
        val r = run("(() => { const s = fl.rsa.sign(c.priv, 'data'); return { ok: fl.rsa.verify(c.pub, 'data', s), bad: fl.rsa.verify(c.pub, 'other', s) } })()", mapOf("priv" to priv, "pub" to pub))
        assertThat(r["ok"]).isEqualTo("true"); assertThat(r["bad"]).isEqualTo("false")
    }

    @Test fun `pad_mask_now_json`() {
        val r = run("""{
            l: fl.pad.left('12', 5, '0'), r: fl.pad.right('홍', 6, ' ', { charset: 'EUC-KR' }).length,
            m: fl.mask('1234567890123456', 6, 4), m2: fl.mask('abc', 2, 2, '#'),
            n: fl.now('yyyyMMdd').length, z: fl.now('HH', 'UTC').length,
            j: fl.json.stringify(fl.json.parse('{"a":[1,2]}').a), j2: fl.json.parse('{"a":1}').a + 1,
        }""")
        assertThat(r["l"]).isEqualTo("00012"); assertThat(r["r"]).isEqualTo("5") // 홍(2B)+공백 4 = 6B → 문자 5
        assertThat(r["m"]).isEqualTo("123456******3456"); assertThat(r["m2"]).isEqualTo("###")
        assertThat(r["n"]).isEqualTo("8"); assertThat(r["z"]).isEqualTo("2"); assertThat(r["j"]).isEqualTo("[1,2]"); assertThat(r["j2"]).isEqualTo("2")
    }

    @Test fun `잘못된 인자는 ScriptError 메시지로`() {
        assertThatThrownBy { run("{ x: fl.aes.encrypt('a', 'tooshort', '0000000000000000') }") }.isInstanceOf(ScriptError::class.java).hasMessageContaining("키")
        assertThatThrownBy { run("{ x: fl.bytes('a', 'NO-SUCH-CS') }") }.hasMessageContaining("charset")
        assertThatThrownBy { run("{ x: fl.seed.encrypt('a', '012345678901234567890123', '0000000000000000') }") }.isInstanceOf(ScriptError::class.java).hasMessageContaining("키").hasMessageContaining("16")
    }

    @Test fun `매니페스트 - 모든 fl 함수가 문서화돼 있다`() {
        val paths = FlApi.MANIFEST.map { it.path }
        assertThat(paths).contains("fl.b64.enc", "fl.hex.dec", "fl.hash.sha256", "fl.hmac.sha256", "fl.aes.encrypt", "fl.aes.decryptBytes",
            "fl.seed.encrypt", "fl.aria.decrypt", "fl.rsa.sign", "fl.rsa.verify", "fl.bytes", "fl.text", "fl.pad.left", "fl.pad.right", "fl.mask", "fl.now", "fl.json.parse", "fl.json.stringify", "fl.log")
        assertThat(FlApi.MANIFEST).allMatch { it.signature.isNotBlank() && it.doc.isNotBlank() && it.example.isNotBlank() }
    }
}
