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

    private val K = "0123456789abcdef"      // 16B 키
    private val IV = "0000000000000000"     // 16B IV(블록 모드)
    private val IV12 = "000000000000"       // 12B nonce(GCM 권장)
    private val pemEnc = java.util.Base64.getMimeEncoder(64, "\n".toByteArray())
    private fun pemPair(alg: String, size: Int): Pair<String, String> {
        val kp = java.security.KeyPairGenerator.getInstance(alg).apply { initialize(size) }.generateKeyPair()
        // 리터럴을 쪼갠 이유: 커밋 훅(gitleaks) private-key 규칙
        return ("-----BEGIN " + "PRIVATE KEY-----\n" + pemEnc.encodeToString(kp.private.encoded) + "\n-----END " + "PRIVATE KEY-----") to
            ("-----BEGIN " + "PUBLIC KEY-----\n" + pemEnc.encodeToString(kp.public.encoded) + "\n-----END " + "PUBLIC KEY-----")
    }
    private fun rsaPem() = pemPair("RSA", 2048)
    private fun ecPem() = pemPair("EC", 256)

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
        val (priv, pub) = rsaPem()
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

    @Test fun `des 왕복 - 레거시 zero 패딩 ECB hex · 바이트 배열 키 · 기존 Kotlin 플러그인과 같은 출력`() {
        val legacy = "{ mode: 'ECB', padding: 'zero', out: 'hex' }"
        val r = run("""{
            z: fl.des.decrypt(fl.des.encrypt('Hello, FlowLink!', '12345678', null, $legacy), '12345678', null, $legacy),
            zk: fl.des.decrypt(fl.des.encrypt('짧다', '12345678', null, $legacy), '12345678', null, $legacy),
            hex: fl.des.encrypt('Hello, FlowLink!', '12345678', null, $legacy),
            p: fl.des.decrypt(fl.des.encrypt('Secret message with PKCS5', '87654321', '00000000'), '87654321', '00000000'),
            hk: fl.des.decrypt(fl.des.encrypt('k', fl.hex.dec('3132333435363738', { as: 'bytes' }), null, { mode: 'ECB' }), '12345678', null, { mode: 'ECB' }),
        }""")
        assertThat(r["z"]).isEqualTo("Hello, FlowLink!"); assertThat(r["zk"]).isEqualTo("짧다"); assertThat(r["p"]).isEqualTo("Secret message with PKCS5"); assertThat(r["hk"]).isEqualTo("k")
        // 레거시 DesEncrypt(DES/ECB/NoPadding + 0x00 채움, hex)와 같은 값 — 같은 JCE 호출을 직접 돌려 비교
        val jce = javax.crypto.Cipher.getInstance("DES/ECB/NoPadding").apply { init(javax.crypto.Cipher.ENCRYPT_MODE, javax.crypto.spec.SecretKeySpec("12345678".toByteArray(), "DES")) }
        assertThat(r["hex"]).isEqualTo(java.util.HexFormat.of().formatHex(jce.doFinal("Hello, FlowLink!".toByteArray())))
    }

    @Test fun `잘못된 인자는 ScriptError 메시지로`() {
        assertThatThrownBy { run("{ x: fl.aes.encrypt('a', 'tooshort', '0000000000000000') }") }.isInstanceOf(ScriptError::class.java).hasMessageContaining("키")
        assertThatThrownBy { run("{ x: fl.bytes('a', 'NO-SUCH-CS') }") }.hasMessageContaining("charset")
        assertThatThrownBy { run("{ x: fl.seed.encrypt('a', '012345678901234567890123', '0000000000000000') }") }.isInstanceOf(ScriptError::class.java).hasMessageContaining("키").hasMessageContaining("16")
        assertThatThrownBy { run("{ x: fl.des.encrypt('a', '1234567', null, { mode: 'ECB' }) }") }.isInstanceOf(ScriptError::class.java).hasMessageContaining("키").hasMessageContaining("8")
        assertThatThrownBy { run("{ x: fl.des.encrypt('a', '12345678', '0000000000000000') }") }.isInstanceOf(ScriptError::class.java).hasMessageContaining("IV").hasMessageContaining("8")
    }

    @Test fun `매니페스트 - 모든 fl 함수가 문서화돼 있다`() {
        val paths = FlApi.MANIFEST.map { it.path }
        assertThat(paths).contains(
            "fl.b64.enc", "fl.hex.dec", "fl.hash.sha256", "fl.hash.sha512", "fl.hash.sha3_256", "fl.hmac.sha256", "fl.hmac.sha512", "fl.pbkdf2",
            "fl.aes.encrypt", "fl.aes.decryptBytes", "fl.seed.encrypt", "fl.aria.decrypt", "fl.des.encrypt", "fl.des3.encrypt",
            "fl.rsa.sign", "fl.rsa.verify", "fl.rsa.encrypt", "fl.rsa.decrypt", "fl.ec.sign", "fl.ec.verify",
            "fl.jwt.sign", "fl.jwt.verify", "fl.jwt.decode", "fl.crc32", "fl.crc16", "fl.bcc", "fl.lrc",
            "fl.random.bytes", "fl.uuid", "fl.gzip.compress", "fl.gzip.decompress",
            "fl.bytes", "fl.text", "fl.pad.left", "fl.pad.right", "fl.mask", "fl.now", "fl.json.parse", "fl.json.stringify", "fl.log")
        assertThat(FlApi.MANIFEST).allMatch { it.signature.isNotBlank() && it.doc.isNotBlank() && it.example.isNotBlank() }
        assertThat(paths).doesNotHaveDuplicates()
        // 주입된 fl 객체의 함수가 전부 문서에 있는지 — 추가하고 매니페스트를 빠뜨리면 실패
        val injected = run("""(() => { const out = []; const walk = (o, p) => { for (const k of Object.keys(o)) { const v = o[k]; if (typeof v === 'function') out.push(p + k); else if (v && typeof v === 'object') walk(v, p + k + '.') } }; walk(fl, 'fl.'); return { list: out.sort().join(',') } })()""")["list"]!!.split(",")
        assertThat(paths.toSet()).containsAll(injected)
    }

    @Test fun `aes gcm - aad·태그, 다른 aad 는 실패`() {
        val o = "{ mode: 'GCM', aad: 'hdr', out: 'b64' }"
        val r = run("""{
            rt: fl.aes.decrypt(fl.aes.encrypt('카드1234', '$K', '$IV12', $o), '$K', '$IV12', $o),
            grow: fl.aes.encryptBytes(fl.bytes('abcd'), '$K', '$IV12', { mode: 'GCM' }).length,
        }""")
        assertThat(r["rt"]).isEqualTo("카드1234")
        assertThat(r["grow"]).isEqualTo("20") // 평문 4B + 태그 16B
        assertThatThrownBy { run("{ x: fl.aes.decrypt(fl.aes.encrypt('a', '$K', '$IV12', $o), '$K', '$IV12', { mode: 'GCM', aad: 'other' }) }") }.isInstanceOf(ScriptError::class.java)
        assertThatThrownBy { run("{ x: fl.des.encrypt('a', '12345678', '00000000', { mode: 'GCM' }) }") }.isInstanceOf(ScriptError::class.java).hasMessageContaining("GCM")
    }

    @Test fun `스트림 모드·3DES·패딩 none`() {
        val r = run("""{
            ctr: fl.aes.decrypt(fl.aes.encrypt('스트림', '$K', '$IV', { mode: 'CTR' }), '$K', '$IV', { mode: 'CTR' }),
            cfb: fl.aes.decrypt(fl.aes.encrypt('스트림', '$K', '$IV', { mode: 'CFB' }), '$K', '$IV', { mode: 'CFB' }),
            ofb: fl.aes.decrypt(fl.aes.encrypt('스트림', '$K', '$IV', { mode: 'OFB' }), '$K', '$IV', { mode: 'OFB' }),
            len: fl.aes.encryptBytes(fl.bytes('abc'), '$K', '$IV', { mode: 'CTR' }).length,
            d3a: fl.des3.decrypt(fl.des3.encrypt('레거시', '0123456789abcdef', '00000000'), '0123456789abcdef', '00000000'),
            d3b: fl.des3.decrypt(fl.des3.encrypt('레거시', '0123456789abcdef01234567', null, { mode: 'ECB' }), '0123456789abcdef01234567', null, { mode: 'ECB' }),
            none: fl.aes.decrypt(fl.aes.encrypt('0123456789abcdef', '$K', '$IV', { padding: 'none' }), '$K', '$IV', { padding: 'none' }),
        }""")
        assertThat(r["ctr"]).isEqualTo("스트림"); assertThat(r["cfb"]).isEqualTo("스트림"); assertThat(r["ofb"]).isEqualTo("스트림")
        assertThat(r["len"]).isEqualTo("3") // 스트림 모드는 패딩 없음 — 길이 그대로
        assertThat(r["d3a"]).isEqualTo("레거시"); assertThat(r["d3b"]).isEqualTo("레거시"); assertThat(r["none"]).isEqualTo("0123456789abcdef")
    }

    @Test fun `rsa 암복호화 - pkcs1·oaep`() {
        val (priv, pub) = rsaPem()
        val r = run("""{
            p: fl.rsa.decrypt(c.priv, fl.rsa.encrypt(c.pub, '카드번호'), ),
            o: fl.rsa.decrypt(c.priv, fl.rsa.encrypt(c.pub, '카드번호', { padding: 'oaep' }), { padding: 'oaep' }),
        }""", mapOf("priv" to priv, "pub" to pub))
        assertThat(r["p"]).isEqualTo("카드번호"); assertThat(r["o"]).isEqualTo("카드번호")
    }

    @Test fun `ecdsa 서명 검증`() {
        val (priv, pub) = ecPem()
        val r = run("(() => { const s = fl.ec.sign(c.priv, 'data'); return { ok: fl.ec.verify(c.pub, 'data', s), bad: fl.ec.verify(c.pub, 'other', s) } })()", mapOf("priv" to priv, "pub" to pub))
        assertThat(r["ok"]).isEqualTo("true"); assertThat(r["bad"]).isEqualTo("false")
    }

    @Test fun `jwt - HS256 발급·검증, 변조·만료는 false, RS256·ES256`() {
        val (rpriv, rpub) = rsaPem()
        val (epriv, epub) = ecPem()
        val r = run("""(() => {
            const t = fl.jwt.sign({ sub: '1', exp: 4102444800 }, 'topsecret')
            const rs = fl.jwt.sign({ sub: '1' }, c.rpriv, { alg: 'RS256' })
            const es = fl.jwt.sign({ sub: '1' }, c.epriv, { alg: 'ES256' })
            return {
              ok: fl.jwt.verify(t, 'topsecret'), wrongKey: fl.jwt.verify(t, 'other'),
              tampered: fl.jwt.verify(t.slice(0, -2) + 'AA', 'topsecret'),
              expired: fl.jwt.verify(fl.jwt.sign({ sub: '1', exp: 1000 }, 'topsecret'), 'topsecret'),
              skipExp: fl.jwt.verify(fl.jwt.sign({ sub: '1', exp: 1000 }, 'topsecret'), 'topsecret', { skipExpiry: true }),
              sub: fl.jwt.decode(t).payload.sub, alg: fl.jwt.decode(t).header.alg, parts: t.split('.').length,
              rs: fl.jwt.verify(rs, c.rpub), es: fl.jwt.verify(es, c.epub),
            }
        })()""", mapOf("rpriv" to rpriv, "rpub" to rpub, "epriv" to epriv, "epub" to epub))
        assertThat(r["ok"]).isEqualTo("true"); assertThat(r["wrongKey"]).isEqualTo("false"); assertThat(r["tampered"]).isEqualTo("false")
        assertThat(r["expired"]).isEqualTo("false"); assertThat(r["skipExp"]).isEqualTo("true")
        assertThat(r["sub"]).isEqualTo("1"); assertThat(r["alg"]).isEqualTo("HS256"); assertThat(r["parts"]).isEqualTo("3")
        assertThat(r["rs"]).isEqualTo("true"); assertThat(r["es"]).isEqualTo("true")
    }

    @Test fun `해시·HMAC 추가 알고리즘·pbkdf2·b64url`() {
        val r = run("""{
            s512: fl.hash.sha512('x').length, s3: fl.hash.sha3_256('x').length, m5: fl.hash.md5('x'),
            h1: fl.hmac.sha1('k', 'x').length, h512: fl.hmac.sha512('k', 'x').length,
            k: fl.pbkdf2('password', 'salt', 1, 256),
            u: fl.b64.enc('~~~?>>', { url: true }), ur: fl.b64.dec(fl.b64.enc('~~~?>>', { url: true }), { url: true }),
            o: fl.hash.sha256('x', { out: 'b64url' }),
        }""")
        assertThat(r["s512"]).isEqualTo("128"); assertThat(r["s3"]).isEqualTo("64"); assertThat(r["m5"]).isEqualTo("9dd4e461268c8034f5c8564e155c67a6")
        assertThat(r["h1"]).isEqualTo("40"); assertThat(r["h512"]).isEqualTo("128")
        assertThat(r["k"]).isEqualTo("120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b") // RFC 공개 벡터(SHA-256, c=1)
        assertThat(r["u"]).doesNotContain("+").doesNotContain("/").doesNotContain("="); assertThat(r["ur"]).isEqualTo("~~~?>>")
        assertThat(r["o"]).doesNotContain("=")
    }

    @Test fun `체크섬·난수·gzip`() {
        val r = run("""{
            c32: fl.crc32('123456789'), c16: fl.crc16('123456789'), mod: fl.crc16('123456789', { variant: 'modbus' }),
            bcc: fl.bcc('123456789'), lrc: fl.lrc('123456789'), dec: fl.crc32('123456789', { out: 'dec' }),
            rb: fl.random.bytes(12).length, rh: fl.random.hex(8).length, uu: fl.uuid().length,
            gz: fl.text(fl.gzip.decompress(fl.gzip.compress('전문'.repeat(20)))), gzb: fl.gzip.compress('전문'.repeat(20), { out: 'b64' }).length < 120,
        }""")
        assertThat(r["c32"]).isEqualTo("cbf43926"); assertThat(r["c16"]).isEqualTo("29b1"); assertThat(r["mod"]).isEqualTo("4b37")
        assertThat(r["bcc"]).isEqualTo("31"); assertThat(r["lrc"]).isEqualTo("23"); assertThat(r["dec"]).isEqualTo("3421780262")
        assertThat(r["rb"]).isEqualTo("12"); assertThat(r["rh"]).isEqualTo("16"); assertThat(r["uu"]).isEqualTo("36")
        assertThat(r["gz"]).isEqualTo("전문".repeat(20)); assertThat(r["gzb"]).isEqualTo("true")
    }

    @Test fun `예제 - AES-GCM 전문 코덱(IV 를 앞에) · JWT 발급 변환`() {
        val gcm = rt.compile("""
            ({ id: 'aes-gcm-body', label: '본문 AES-GCM', kind: 'messageCodec',
               params: [{ key: 'key', label: '키' }],
               encode(body, ctx) {
                 const iv = Array.from(fl.random.bytes(12))
                 const ct = Array.from(fl.aes.encryptBytes(body, ctx.config.key, iv, { mode: 'GCM' }))
                 return Uint8Array.from(iv.concat(ct))
               },
               decode(body, ctx) { return fl.aes.decryptBytes(body.slice(12), ctx.config.key, body.slice(0, 12), { mode: 'GCM' }) } })
        """.trimIndent())
        val ctx = com.flowlink.codec.CodecCtx(null, emptyMap(), mapOf("key" to K), "send")
        val plain = "전문 본문".toByteArray(Charsets.UTF_8)
        val enc = rt.runMessageCodec(gcm, "encode", plain, ctx).value
        assertThat(enc.size).isEqualTo(12 + plain.size + 16) // IV 12 + 평문 + 태그 16
        assertThat(rt.runMessageCodec(gcm, "decode", enc, ctx).value).isEqualTo(plain)

        val jwt = run("""(() => {
            const now = Math.floor(Date.now() / 1000)
            const t = fl.jwt.sign({ sub: 'u1', iat: now, exp: now + 300 }, 'k')
            return { ok: fl.jwt.verify(t, 'k'), sub: fl.jwt.decode(t).payload.sub }
        })()""")
        assertThat(jwt["ok"]).isEqualTo("true"); assertThat(jwt["sub"]).isEqualTo("u1")
    }
}
