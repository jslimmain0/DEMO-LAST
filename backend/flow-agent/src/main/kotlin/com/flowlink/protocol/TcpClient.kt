package com.flowlink.protocol

import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket

/** 전문 1회 왕복 — TCP 노드와 Mock '보내보기'가 같은 코드. 연결·응답 타임아웃 = timeoutMs. */
object TcpClient {
    class Exchange(val response: Framer.Frame, val elapsedMs: Long)

    fun exchange(host: String, port: Int, timeoutMs: Int, request: ByteArray, spec: ProtocolSpec): Exchange {
        val t = if (timeoutMs <= 0) 5000 else timeoutMs
        Socket().use { s ->
            s.connect(InetSocketAddress(host, port), t)
            s.soTimeout = t
            val t0 = System.nanoTime()
            s.getOutputStream().apply { write(request); flush() }
            val f = Framer.readFrame(s.getInputStream(), spec) ?: throw IOException("응답 없이 연결이 닫혔습니다.")
            return Exchange(f, (System.nanoTime() - t0) / 1_000_000)
        }
    }
}
