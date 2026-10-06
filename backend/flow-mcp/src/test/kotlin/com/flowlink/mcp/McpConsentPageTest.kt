package com.flowlink.mcp

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class McpConsentPageTest {
    @Test fun `dynamic text is escaped and cancellation grants no scope`() {
        val page = McpConsentPage.render("<app>", "<login>", "\"client", "\"state", "/flowlink")
        assertFalse(page.contains("<app>"))
        assertTrue(page.contains("&lt;app&gt;"))
        assertTrue(page.contains("&lt;login&gt;"))
        assertTrue(page.contains("&quot;client"))
        assertTrue(page.contains("&quot;state"))
        assertTrue(page.contains("action=\"/flowlink/authorize\""))
        val forms = Regex("<form.*?</form>").findAll(page).map { it.value }.toList()
        assertEquals(2, forms.size)
        assertFalse(forms[0].contains("name=\"scope\""))
        assertTrue(forms[1].contains("name=\"scope\" value=\"flowlink\""))
    }
}
