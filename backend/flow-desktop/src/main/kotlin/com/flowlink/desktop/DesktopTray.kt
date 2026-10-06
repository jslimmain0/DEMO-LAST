package com.flowlink.desktop

import com.fasterxml.jackson.databind.ObjectMapper
import jakarta.annotation.PreDestroy
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.ConfigurableApplicationContext
import org.springframework.context.annotation.Profile
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Component
import java.awt.*
import java.awt.datatransfer.StringSelection
import java.net.URI
import java.nio.file.Files
import javax.swing.*

@Component
@Profile("desktop")
class DesktopTray(
    private val session: DesktopSession,
    private val mapper: ObjectMapper,
    private val context: ConfigurableApplicationContext,
    private val remote: DesktopConnection,
    @Value("\${flowlink.desktop.tray:true}") private val enabled: Boolean,
    @Value("\${flowlink.desktop.open-browser:true}") private val openBrowser: Boolean,
) {
    private var tray: TrayIcon? = null
    private var refresh: Timer? = null
    private var loginWindow: JDialog? = null
    private var setupWindow: JDialog? = null
    private val welcomeFile get() = session.directory.resolve("welcome.done")

    @EventListener(ApplicationReadyEvent::class)
    fun ready() {
        session.publish(mapper)
        if (!enabled) return
        check(SystemTray.isSupported()) { "트레이를 사용할 수 없습니다. 서버 실행은 desktop 프로파일 없이 사용하세요." }
        EventQueue.invokeLater {
            DesktopBrand.configure()
            val menu = PopupMenu()
            val serverStatus = MenuItem().apply { isEnabled = false }
            menu.add(MenuItem("내 PC · 실행 중").apply { isEnabled = false })
            menu.add(serverStatus); menu.addSeparator()
            fun item(label: String, action: () -> Unit) = MenuItem(label).also {
                it.addActionListener { guarded(action) }; menu.add(it)
            }
            item("개인 워크스페이스 열기") { browse(session.browserUrl() + "&runtime=local") }
            val serverOpen = item("서버 워크스페이스 열기") {
                if (remote.view().connected) browse(session.browserUrl() + "&runtime=server") else loginDialog()
            }
            item("회사 계정 보기 · 변경") { loginDialog() }
            item("IDE · 자동 연결…") { connectDialog() }
            menu.addSeparator()
            item("앱 홈") { welcomeDialog() }
            item("연결 상태 · 자동 설정") { statusDialog() }
            item("앱 업데이트…") { updateDialog() }
            val logout = item("서버 로그아웃") {
                remote.logout()
                tray?.displayMessage("서버 로그아웃", "개인 워크스페이스는 계속 사용할 수 있습니다.", TrayIcon.MessageType.INFO)
            }
            menu.addSeparator()
            item("FlowLink 종료…") {
                if (JOptionPane.showConfirmDialog(null,
                        "PC 에이전트를 종료할까요?\n\n진행 중인 PC 요청의 결과를 확인하지 못할 수 있습니다.\n이미 전송된 요청은 대상 시스템에서 계속 처리될 수 있습니다.\n다시 켜면 저장된 실행을 복구하며, 결과 불명 작업은 자동 재호출하지 않습니다.",
                        "FlowLink 종료", JOptionPane.YES_NO_OPTION, JOptionPane.WARNING_MESSAGE) == JOptionPane.YES_OPTION) {
                    closeTray(); Thread { context.close() }.start()
                }
            }
            tray = TrayIcon(DesktopBrand.icon(64), "FlowLink · 개인 에이전트", menu).also {
                it.isImageAutoSize = true; it.addActionListener { guarded { browse(session.browserUrl()) } }
                SystemTray.getSystemTray().add(it)
            }
            var previous: DesktopConnection.View? = null
            fun update() {
                val state = remote.view()
                if (state == previous) return
                previous = state
                serverStatus.label = if (state.connected) "회사 계정 · ${state.login} 정보 저장됨" else "회사 계정 · 로그인 필요"
                serverOpen.label = if (state.connected) "서버 워크스페이스 열기" else "서버 로그인하고 열기…"
                logout.isEnabled = state.connected
                tray?.image = DesktopBrand.icon(64, state.connected)
                tray?.toolTip = "FlowLink · 내 PC 실행 중\n${serverStatus.label}"
            }
            update(); refresh = Timer(2000) { update() }.apply { start() }
            if (openBrowser) guarded {
                if (Files.exists(welcomeFile)) browse(session.browserUrl()) else welcomeDialog()
            }
        }
    }

    private fun guarded(action: () -> Unit) {
        runCatching(action).onFailure { JOptionPane.showMessageDialog(null, it.message ?: "작업을 완료하지 못했습니다.", "FlowLink", JOptionPane.ERROR_MESSAGE) }
    }
    private fun browse(url: String) = Desktop.getDesktop().browse(URI.create(url))
    private fun copy(value: String) = Toolkit.getDefaultToolkit().systemClipboard.setContents(StringSelection(value), null)
    private fun button(title: String, prominent: Boolean = false, action: () -> Unit) = DesktopBrand.button(title, prominent).apply { addActionListener { guarded(action) } }
    private fun row(vararg controls: java.awt.Component) = JPanel(FlowLayout(FlowLayout.RIGHT, 8, 0)).apply { isOpaque = false; controls.forEach { add(it) } }
    private fun text(value: String) = object : JTextArea(value) {
        override fun getPreferredSize(): Dimension {
            val wrapWidth = (width.takeIf { it > 40 } ?: 420).coerceAtLeast(100)
            val view = getUI().getRootView(this)
            view.setSize(wrapWidth.toFloat(), Float.MAX_VALUE)
            return Dimension(0, kotlin.math.ceil(view.getPreferredSpan(javax.swing.text.View.Y_AXIS).toDouble()).toInt())
        }
        override fun getMinimumSize() = preferredSize
        override fun getMaximumSize() = Dimension(Int.MAX_VALUE, preferredSize.height)
    }.apply {
        font = DesktopBrand.body; foreground = DesktopBrand.muted; isEditable = false; isOpaque = false
        lineWrap = true; wrapStyleWord = true; isFocusable = false; border = null
        addComponentListener(object : java.awt.event.ComponentAdapter() {
            private var measuredWidth = -1
            override fun componentResized(event: java.awt.event.ComponentEvent) {
                if (width != measuredWidth) {
                    measuredWidth = width
                    revalidate()
                    parent?.revalidate()
                }
            }
        })
    }
    private fun stack(vararg components: JComponent) = object : JPanel(), Scrollable {
        override fun getMaximumSize() = Dimension(Int.MAX_VALUE, preferredSize.height)
        override fun getPreferredScrollableViewportSize() = preferredSize
        override fun getScrollableUnitIncrement(visibleRect: java.awt.Rectangle, orientation: Int, direction: Int) = 18
        override fun getScrollableBlockIncrement(visibleRect: java.awt.Rectangle, orientation: Int, direction: Int) = maxOf(18, visibleRect.height - 18)
        override fun getScrollableTracksViewportWidth() = true
        override fun getScrollableTracksViewportHeight() = false
    }.apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS); isOpaque = false
        components.forEachIndexed { index, c ->
            if (index > 0) add(Box.createVerticalStrut(8))
            c.alignmentX = java.awt.Component.LEFT_ALIGNMENT; add(c)
        }
    }
    private fun body(content: JPanel, component: JComponent) {
        content.add(JScrollPane(component).apply {
            border = BorderFactory.createEmptyBorder(); horizontalScrollBarPolicy = JScrollPane.HORIZONTAL_SCROLLBAR_NEVER
            background = DesktopBrand.background; viewport.background = DesktopBrand.background
            verticalScrollBar.unitIncrement = 18
        }, BorderLayout.CENTER)
    }
    private fun card(title: String, body: String, trailing: JComponent? = null) = DesktopBrand.surface().apply {
        add(JLabel(title).apply { font = DesktopBrand.body.deriveFont(Font.BOLD); foreground = DesktopBrand.text }, BorderLayout.NORTH)
        add(text(body), BorderLayout.CENTER); trailing?.let { add(row(it), BorderLayout.SOUTH) }
    }
    private fun window(title: String, subtitle: String, width: Int = 700, height: Int = 560): Pair<JDialog, JPanel> {
        val dialog = JDialog(null as Frame?, "FlowLink · $title", false).apply {
            defaultCloseOperation = WindowConstants.DISPOSE_ON_CLOSE; setIconImage(DesktopBrand.icon(64))
            minimumSize = Dimension(520, 380)
        }
        val header = JPanel(BorderLayout(14, 0)).apply {
            isOpaque = false; add(JLabel(ImageIcon(DesktopBrand.icon(36))).apply { verticalAlignment = SwingConstants.TOP }, BorderLayout.WEST)
            add(stack(JLabel("FlowLink Windows").apply { font = DesktopBrand.small; foreground = DesktopBrand.primary }, JLabel(title).apply { font = DesktopBrand.body.deriveFont(Font.BOLD, 22f); foreground = DesktopBrand.text }, text(subtitle)), BorderLayout.CENTER)
        }
        val content = JPanel(BorderLayout(0, 16)).apply {
            background = DesktopBrand.background; border = BorderFactory.createEmptyBorder(20, 22, 20, 22)
            add(header, BorderLayout.NORTH); preferredSize = Dimension(width, height)
        }
        dialog.contentPane = content
        dialog.rootPane.registerKeyboardAction({ dialog.dispose() }, KeyStroke.getKeyStroke("ESCAPE"), JComponent.WHEN_IN_FOCUSED_WINDOW)
        return dialog to content
    }
    private fun show(dialog: JDialog) {
        dialog.pack()
        val bounds = GraphicsEnvironment.getLocalGraphicsEnvironment().maximumWindowBounds
        dialog.setSize(dialog.width.coerceAtMost(bounds.width - 32), dialog.height.coerceAtMost(bounds.height - 32))
        dialog.setLocationRelativeTo(null); dialog.isVisible = true
    }

    private fun welcomeDialog() {
        if (setupWindow?.isDisplayable == true) { setupWindow?.toFront(); return }
        show(buildWelcomeDialog())
    }

    private fun buildWelcomeDialog(): JDialog {
        val (dialog, content) = window("작업을 이어가세요", "워크스페이스는 기본 브라우저에서 열립니다. 개인 작업은 로그인 없이 사용할 수 있습니다.", height = 520)
        setupWindow = dialog
        val nextTime = JCheckBox("다음 실행부터 개인 워크스페이스 바로 열기", true).apply { isOpaque = false }
        fun remember() { if (nextTime.isSelected) Files.writeString(welcomeFile, "1") else Files.deleteIfExists(welcomeFile) }
        val state = remote.view()
        body(content, stack(
            DesktopBrand.surface().apply {
                border = BorderFactory.createEmptyBorder(10, 16, 10, 16)
                add(JLabel("내 PC 준비됨").apply { font = DesktopBrand.body.deriveFont(Font.BOLD); foreground = DesktopBrand.text }, BorderLayout.WEST)
                add(text("개인 작업 · 로그인 없이 사용"), BorderLayout.CENTER)
            },
            card("회사 계정", if (state.connected) "로그인 정보 저장됨 · ${state.login}\n${state.serverUrl}" else if (state.serverUrl.isNotBlank()) "로그인 필요 · ${state.serverUrl}" else "회사 서버가 아직 설정되지 않았습니다. 개인 작업은 바로 사용할 수 있습니다.",
                if (state.connected) row(
                    button("회사 워크스페이스 열기") { remember(); browse(session.browserUrl() + "&runtime=server"); dialog.dispose() },
                    button("계정 보기 · 변경") { remember(); loginDialog() })
                else button("회사 계정 로그인") { remember(); loginDialog() }),
            text("PC 주소와 저장 위치는 자동 설정됩니다. 앱 버전 · ${com.flowlink.common.release.ReleaseVersion.version}"),
            row(button("자동 설정 보기") { statusDialog() }, button("IDE · 서버 MCP") { connectDialog() }, button("앱 업데이트") { updateDialog() }),
            nextTime,
        ))
        val start = button("개인 워크스페이스 열기", true) { remember(); browse(session.browserUrl() + "&runtime=local"); dialog.dispose() }
        content.add(row(button("닫기") { remember(); dialog.dispose() }, start), BorderLayout.SOUTH)
        dialog.rootPane.defaultButton = start
        return dialog
    }

    private fun statusDialog() {
        show(buildStatusDialog())
    }

    private fun buildStatusDialog(): JDialog {
        val state = remote.view()
        val (dialog, content) = window("연결 상태와 자동 설정", "앱이 관리하는 설정을 확인합니다. 저장된 계정과 실제 서버 접속은 구분합니다.", height = 560)
        body(content, stack(
            card("내 PC · 준비됨", "자동 설정 주소: ${session.baseUrl}\n개인 저장 위치: ${session.directory}"),
            card(if (state.connected) "회사 계정 · ${state.login}" else "회사 계정 · 로그인 필요",
                "서버 주소: ${state.serverUrl.ifBlank { "설정되지 않음" }}\n" +
                    (if (state.connected) "서버 작업이 멈추면 네트워크와 앱의 실행 상태를 확인하세요." else "개인 작업은 계속할 수 있습니다. 팀 작업은 실행을 시작한 계정으로 로그인하세요."),
                button(if (state.connected) "계정 보기 · 변경" else "회사 계정 로그인") { loginDialog() }),
            text("서버 계정은 이 Windows 앱에서 관리합니다. 개인 자료는 서버 로그아웃 후에도 이 PC에 남습니다."),
        ))
        content.add(row(button("로그 폴더 열기") {
            val folder = session.directory.resolve("logs"); Files.createDirectories(folder); Desktop.getDesktop().open(folder.toFile())
        }, button("닫기") { dialog.dispose() }), BorderLayout.SOUTH)
        return dialog
    }

    fun updateDialog() {
        check(enabled && !GraphicsEnvironment.isHeadless()) { "Windows 앱의 업데이트 창을 사용할 수 없습니다." }
        EventQueue.invokeLater { guarded { show(buildUpdateDialog()) } }
    }

    private fun buildUpdateDialog(): JDialog {
        val updates = context.getBeanProvider(DesktopUpdateService::class.java).getIfAvailable()
        val (dialog, content) = window("앱 업데이트", "개인 자료는 그대로 유지됩니다. 설치할 때 앱과 Mock 수신이 잠시 중단됩니다.", height = 600)
        fun describe(state: DesktopUpdateService.View) = listOfNotNull(state.availableVersion?.let { "배포 버전 $it" }, state.message,
            if (state.phase == "downloading") "${state.downloadedBytes / 1024} / ${state.totalBytes / 1024} KB" else null).joinToString("\n")
        val status = text(updates?.view()?.let(::describe) ?: "업데이트 서비스를 사용할 수 없습니다.")
        val notes = text(updates?.view()?.releaseNotes.orEmpty())
        val saved = JCheckBox("열려 있는 모든 작업 화면의 변경을 저장했습니다.").apply { isOpaque = false }
        val check = button("지금 확인") { updates?.checkUpdate() }
        val download = button("다운로드") { updates?.download() }
        val install = button("저장 확인 후 설치", true) {
            if (saved.isSelected && JOptionPane.showConfirmDialog(dialog,
                "설치 중에는 PC 앱과 HTTP/TCP Mock 수신이 중단됩니다.\n진행 중인 실행과 대기 작업은 먼저 마쳐야 합니다.\n지금 설치할까요?", "업데이트 설치", JOptionPane.YES_NO_OPTION,
                JOptionPane.WARNING_MESSAGE) == JOptionPane.YES_OPTION) Thread {
                    runCatching { updates?.install() }.onFailure { error -> EventQueue.invokeLater { JOptionPane.showMessageDialog(dialog, error.message ?: "설치를 시작하지 못했습니다.", "업데이트", JOptionPane.ERROR_MESSAGE) } }
                }.start()
        }
        check.isEnabled = updates != null
        download.isEnabled = updates?.view()?.phase == "available"
        install.isEnabled = false
        body(content, stack(card("현재 버전", updates?.view()?.currentVersion ?: com.flowlink.common.release.ReleaseVersion.version), status, notes,
            text("새 버전은 자동으로 확인합니다. 다운로드와 설치는 직접 선택합니다.\n다운로드 중에는 작업을 계속할 수 있습니다. 설치하면 앱과 Mock 수신이 잠시 중단됩니다."), saved))
        content.add(row(check, download, install), BorderLayout.SOUTH)
        val refresh = Timer(500) {
            val state = updates?.view() ?: DesktopUpdateService.View("error", com.flowlink.common.release.ReleaseVersion.version, message = "업데이트 서비스를 사용할 수 없습니다.")
            status.text = describe(state)
            notes.text = state.releaseNotes.orEmpty()
            check.isEnabled = updates != null && state.phase !in listOf("checking", "downloading", "installing")
            download.isEnabled = state.phase == "available" || (state.phase == "error" && state.availableVersion != null)
            install.isEnabled = state.phase == "ready" && saved.isSelected
        }.apply { initialDelay = 0; start() }
        dialog.addWindowListener(object : java.awt.event.WindowAdapter() { override fun windowClosed(event: java.awt.event.WindowEvent) { refresh.stop() } })
        return dialog
    }

    private fun connectDialog() {
        show(buildConnectDialog())
    }

    private fun buildConnectDialog(): JDialog {
        val (dialog, content) = window("IDE 자동 연결", "Windows 앱에 한 번 로그인하면 Copilot에서도 회사 서버 도구를 사용합니다.", height = 540)
        val setup = context.getBeanProvider(DesktopMcpSetup::class.java).ifAvailable
        val mcp = remote.view().mcpUrl
        val status = text(setup?.view()?.message ?: "자동 설정을 확인하지 못했습니다.")
        val clients = text("")
        body(content, stack(
            card("회사 MCP 주소", if (mcp.isNotBlank()) mcp else "서버 MCP 주소를 아직 확인하지 못했습니다. 회사 연결 안내를 확인하세요.",
                button("주소 복사") { copy(mcp) }.apply { isEnabled = mcp.isNotBlank() }),
            card("앱 로그인 공유", "로그인하면 VS Code · IntelliJ Copilot의 사용자 설정에 주소와 MCP 전용 토큰을 자동 적용합니다. 토큰은 자동 갱신하고 로그아웃하면 연결을 해제합니다."),
            status, clients,
            text("설정 완료 후 IDE에서 도구 사용을 승인하세요. 다른 MCP 서버 설정은 유지합니다. 여기서는 설정 적용 상태를 표시합니다."),
        ))
        content.add(row(button("회사 계정") { loginDialog() }, button("설정 다시 확인", true) { setup?.request() }, button("닫기") { dialog.dispose() }), BorderLayout.SOUTH)
        val timer = Timer(1000) {
            val view = setup?.view() ?: return@Timer
            status.text = view.message + if (view.pendingRevocations > 0) "\n이전 연결 해제 대기: ${view.pendingRevocations}" else ""
            clients.text = view.clients.joinToString("\n") { "${it.label} · ${it.message}" }
        }.apply { initialDelay = 0; start() }
        dialog.addWindowListener(object : java.awt.event.WindowAdapter() { override fun windowClosed(event: java.awt.event.WindowEvent) { timer.stop() } })
        return dialog
    }
    fun loginDialog() {
        if (!EventQueue.isDispatchThread()) { EventQueue.invokeLater { loginDialog() }; return }
        if (loginWindow?.isDisplayable == true) { loginWindow?.toFront(); return }
        show(buildLoginDialog())
    }

    private fun buildLoginDialog(): JDialog {
        val (dialog, content) = window("회사 계정", "한 번 로그인하면 이 앱이 여는 작업 화면에서 회사 공간을 사용합니다. 개인 자료는 그대로 유지됩니다.", height = 480)
        loginWindow = dialog
        val address = DesktopBrand.field(JTextField(remote.view().serverUrl)).apply { accessibleContext.accessibleName = "사내 FlowLink 서버 주소" }
        val status = text(if (remote.view().connected) "로그인 정보 저장됨 · ${remote.view().login}" else "브라우저에서 회사 계정을 인증합니다.")
        val code = DesktopBrand.field(JTextField("미발급")).apply {
            isEditable = false; font = DesktopBrand.body.deriveFont(Font.BOLD, 24f); horizontalAlignment = JTextField.CENTER
            accessibleContext.accessibleName = "GitHub 인증 코드"
        }
        var verification = ""
        val visit = button("인증 페이지 열기") { if (verification.isNotBlank()) browse(verification) }.apply { isEnabled = false }
        val copyCode = button("코드 복사") { if (code.text.isNotBlank()) copy(code.text) }.apply { isEnabled = false }
        val start = DesktopBrand.button(if (remote.view().connected) "다른 계정으로 로그인" else "로그인 시작", !remote.view().connected)
        val addressEditor = stack(JLabel("회사 서버 주소").apply { labelFor = address }, address,
            text("서버 주소를 변경하면 기존 회사 계정에서 로그아웃됩니다."))
        val knownServer = remote.view().serverUrl.isNotBlank()
        addressEditor.isVisible = !knownServer
        val changeServer = button("서버 변경") {
            addressEditor.isVisible = !addressEditor.isVisible
            content.revalidate(); content.repaint()
            if (addressEditor.isVisible) address.requestFocusInWindow()
        }
        val serverSection = card("연결할 회사 서버", if (knownServer) remote.view().serverUrl else "주소를 입력하세요.", changeServer)
        val authPanel = DesktopBrand.surface().apply {
            add(JLabel("브라우저 인증 코드").apply { font = DesktopBrand.small; foreground = DesktopBrand.muted }, BorderLayout.NORTH)
            add(code, BorderLayout.CENTER); add(row(copyCode, visit), BorderLayout.SOUTH)
            isVisible = false
        }
        body(content, stack(serverSection, addressEditor, status, authPanel,
            text(if (remote.view().connected) "현재 계정으로 회사 작업을 열 수 있습니다. 계정 변경은 다시 인증할 때만 필요합니다." else "로그인을 시작하면 기본 브라우저가 열립니다. 인증을 마치면 워크스페이스로 이어집니다.")))
        val openCompany = button("회사 워크스페이스 열기", true) {
            browse(session.browserUrl() + "&runtime=server"); dialog.dispose(); setupWindow?.dispose()
        }
        content.add(if (remote.view().connected) row(start, openCompany, button("닫기") { dialog.dispose() })
            else row(start, button("닫기") { dialog.dispose() }), BorderLayout.SOUTH)
        dialog.rootPane.defaultButton = if (remote.view().connected) openCompany else start
        start.addActionListener {
            val value = address.text.trim()
            if (value.isBlank()) { status.text = "서버 주소를 입력하세요."; address.requestFocusInWindow(); return@addActionListener }
            start.isEnabled = false; address.isEditable = false; visit.isEnabled = false; copyCode.isEnabled = false; changeServer.isEnabled = false
            authPanel.isVisible = true; content.revalidate(); content.repaint()
            status.text = "서버에 로그인 요청 중…"; status.foreground = DesktopBrand.muted; code.text = ""
            Thread {
                runCatching {
                    remote.configure(value); val device = remote.start()
                    val link = device["verificationUri"]?.toString().orEmpty()
                    EventQueue.invokeLater { if (dialog.isDisplayable) {
                        verification = link; code.text = device["userCode"]?.toString().orEmpty()
                        status.text = if (link.isBlank()) "개발용 모킹 로그인 진행 중 · GitHub 인증 없음" else "브라우저에서 인증 코드를 승인하세요."
                        copyCode.isEnabled = code.text.isNotBlank(); visit.isEnabled = link.isNotBlank()
                        if (link.isNotBlank()) runCatching { browse(link) }.onFailure { status.text = "브라우저를 열지 못했습니다. '인증 페이지 열기'를 눌러주세요." }
                    } }
                    val deadline = System.currentTimeMillis() + (device["expiresIn"] as Number).toLong() * 1000
                    var complete = false
                    while (dialog.isDisplayable && System.currentTimeMillis() < deadline) {
                        Thread.sleep((device["intervalSec"] as Number).toLong().coerceAtLeast(2) * 1000)
                        if (!dialog.isDisplayable) break
                        val result = remote.poll()
                        if (result["status"] == "error") error(result["error"]?.toString() ?: "로그인을 완료하지 못했습니다. 다시 시도하세요.")
                        if (result["status"] == "ready") {
                            complete = true
                            EventQueue.invokeLater { if (dialog.isDisplayable) {
                                dialog.dispose(); setupWindow?.dispose(); guarded { browse(session.browserUrl() + "&runtime=server") }
                                tray?.displayMessage("서버 로그인 완료", "개인과 팀 워크스페이스를 함께 사용할 수 있습니다.", TrayIcon.MessageType.INFO)
                            } }
                            break
                        }
                    }
                    if (!complete && dialog.isDisplayable) error("인증 시간이 만료되었습니다. 다시 로그인을 시작하세요.")
                }.onFailure { e -> EventQueue.invokeLater { if (dialog.isDisplayable) {
                    status.text = e.message ?: "서버에 연결하지 못했습니다. 주소와 네트워크를 확인하세요."
                    status.foreground = DesktopBrand.attention; start.text = "다시 로그인"; start.isEnabled = true; address.isEditable = true; changeServer.isEnabled = true
                } } }
            }.apply { isDaemon = true; name = "flowlink-desktop-login" }.start()
        }
        return dialog
    }

    @PreDestroy
    fun closeTray() {
        if (!enabled) return
        if (!EventQueue.isDispatchThread()) { EventQueue.invokeLater { closeTray() }; return }
        refresh?.stop(); tray?.let { if (SystemTray.isSupported()) SystemTray.getSystemTray().remove(it) }
        // 상태·IDE 설정·메시지 창도 닫아 AWT 창 때문에 종료된 런타임의 JVM이 남지 않게 한다.
        Window.getWindows().forEach { it.dispose() }
    }
}
