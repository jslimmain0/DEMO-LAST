package com.flowlink.desktop

import java.awt.BasicStroke
import java.awt.Color
import java.awt.Font
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import javax.swing.UIManager
import javax.swing.JButton
import javax.swing.JTextField
import javax.swing.BorderFactory
import javax.swing.JPanel
import javax.swing.plaf.basic.BasicButtonUI
import javax.swing.plaf.basic.BasicTextFieldUI
import javax.swing.border.AbstractBorder
import javax.swing.plaf.FontUIResource

/** 설치 아이콘과 같은 두 실행 지점의 연결 표시. 웹 화면의 브랜드 토큰(index.css --fl-*)과 같은 값을 쓴다. */
/** 폭이 모자라면 다음 줄로 넘기는 FlowLayout — 좁은 창에서 버튼 줄이 잘리지 않게 선호 높이를 줄 수만큼 계산한다. */
internal class WrapLayout(align: Int, hgap: Int, vgap: Int) : java.awt.FlowLayout(align, hgap, vgap) {
    override fun preferredLayoutSize(target: java.awt.Container) = layoutSize(target, true)
    override fun minimumLayoutSize(target: java.awt.Container) = layoutSize(target, false).also { it.width -= hgap + 1 }
    private fun layoutSize(target: java.awt.Container, preferred: Boolean): java.awt.Dimension = synchronized(target.treeLock) {
        var container: java.awt.Container = target
        while (container.width == 0 && container.parent != null) container = container.parent
        val available = container.width.takeIf { it > 0 } ?: Int.MAX_VALUE
        val insets = target.insets
        val maxWidth = available - (insets.left + insets.right + hgap * 2)
        val size = java.awt.Dimension(0, 0)
        var rowWidth = 0; var rowHeight = 0
        fun close() { size.width = maxOf(size.width, rowWidth); if (size.height > 0) size.height += vgap; size.height += rowHeight }
        for (child in target.components) if (child.isVisible) {
            val d = if (preferred) child.preferredSize else child.minimumSize
            if (rowWidth > 0 && rowWidth + hgap + d.width > maxWidth) { close(); rowWidth = 0; rowHeight = 0 }
            if (rowWidth > 0) rowWidth += hgap
            rowWidth += d.width; rowHeight = maxOf(rowHeight, d.height)
        }
        close()
        size.width += insets.left + insets.right + hgap * 2
        size.height += insets.top + insets.bottom + vgap * 2
        size
    }
}

internal object DesktopBrand {
    val primary = Color(0x5b, 0x4b, 0xd0)
    val text = Color(0x18, 0x18, 0x1b)
    val muted = Color(0x71, 0x71, 0x7a)
    val background = Color(0xfa, 0xfa, 0xfa)
    val border = Color(0xe4, 0xe4, 0xe7)
    val controlBorder = Color(0xd4, 0xd4, 0xd8)
    val hover = Color(0xf4, 0xf4, 0xf5)
    val success = Color(0x15, 0x80, 0x3d)
    val attention = Color(0xb4, 0x53, 0x09)

    // 모서리 반경(지름 기준 arc). 버튼·입력 6px, 카드 10px — 웹 --fl-radius-sm / --fl-radius-lg
    private const val CONTROL_ARC = 12
    private const val SURFACE_ARC = 20
    val body = Font("맑은 고딕", Font.PLAIN, 14)
    val small = body.deriveFont(12f)

    fun button(label: String, prominent: Boolean = false): JButton = object : JButton(label) {
        override fun paintComponent(graphics: java.awt.Graphics) {
            val g = graphics.create() as java.awt.Graphics2D
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g.color = when {
                !isEnabled -> background
                prominent && model.isPressed -> primary.darker()
                prominent -> primary
                prominent && model.isRollover -> primary.darker()
                model.isRollover -> hover
                else -> Color.WHITE
            }
            g.fillRoundRect(1, 1, width - 2, height - 2, CONTROL_ARC, CONTROL_ARC)
            g.color = if (hasFocus()) primary else if (prominent && isEnabled) primary else controlBorder
            g.stroke = BasicStroke(if (hasFocus()) 2f else 1f)
            g.drawRoundRect(1, 1, width - 3, height - 3, CONTROL_ARC, CONTROL_ARC)
            g.dispose(); super.paintComponent(graphics)
        }
    }.apply {
        setUI(BasicButtonUI()); font = body.deriveFont(Font.BOLD, 13f)
        foreground = if (prominent) Color.WHITE else DesktopBrand.text
        background = DesktopBrand.background
        border = BorderFactory.createEmptyBorder(8, 14, 8, 14)
        isContentAreaFilled = false; isOpaque = false; isFocusPainted = false; isRolloverEnabled = true
        cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
    }

    fun field(field: JTextField): JTextField = field.apply {
        font = body; foreground = DesktopBrand.text; background = Color.WHITE; caretColor = primary
        setUI(object : BasicTextFieldUI() {
            override fun paintSafely(graphics: java.awt.Graphics) {
                val g = graphics.create() as java.awt.Graphics2D
                g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                g.color = if (field.isEnabled) Color.WHITE else DesktopBrand.background
                g.fillRoundRect(1, 1, field.width - 2, field.height - 2, CONTROL_ARC, CONTROL_ARC)
                g.dispose()
                super.paintSafely(graphics)
            }
        })
        isOpaque = false
        border = object : AbstractBorder() {
            override fun getBorderInsets(component: java.awt.Component) = java.awt.Insets(11, 12, 11, 12)
            override fun getBorderInsets(component: java.awt.Component, insets: java.awt.Insets): java.awt.Insets {
                insets.set(11, 12, 11, 12)
                return insets
            }
            override fun paintBorder(component: java.awt.Component, graphics: java.awt.Graphics, x: Int, y: Int, width: Int, height: Int) {
                val g = graphics.create() as java.awt.Graphics2D
                g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                g.color = if (field.hasFocus()) primary else controlBorder
                g.stroke = BasicStroke(if (field.hasFocus()) 2f else 1f)
                g.drawRoundRect(x + 1, y + 1, width - 3, height - 3, CONTROL_ARC, CONTROL_ARC)
                g.dispose()
            }
        }
        addFocusListener(object : java.awt.event.FocusAdapter() {
            override fun focusGained(event: java.awt.event.FocusEvent) { repaint() }
            override fun focusLost(event: java.awt.event.FocusEvent) { repaint() }
        })
        minimumSize = java.awt.Dimension(100, 44)
    }

    fun surface() = object : JPanel(java.awt.BorderLayout(12, 10)) {
        override fun getMaximumSize() = java.awt.Dimension(Int.MAX_VALUE, preferredSize.height)
        override fun paintComponent(graphics: java.awt.Graphics) {
            val g = graphics.create() as java.awt.Graphics2D
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g.color = Color.WHITE; g.fillRoundRect(0, 0, width - 1, height - 1, SURFACE_ARC, SURFACE_ARC)
            g.color = DesktopBrand.border; g.drawRoundRect(0, 0, width - 1, height - 1, SURFACE_ARC, SURFACE_ARC)
            g.dispose(); super.paintComponent(graphics)
        }
    }.apply { isOpaque = false; border = BorderFactory.createEmptyBorder(18, 20, 18, 20) }

    val ink = Color(0x18, 0x18, 0x1b)
    private val inkHover = Color(0x27, 0x27, 0x2a)
    private val divider = Color(0xf4, 0xf4, 0xf5)

    /** 왼쪽 보라 패널 — 배경에 연결선 마크를 옅게 깐다. 폭은 창 폭의 ratio(min~max px). */
    fun sidePanel(ratio: Double = 0.4, min: Int = 200, max: Int = 290) = object : JPanel() {
        override fun getPreferredSize(): java.awt.Dimension {
            val base = super.getPreferredSize()
            val width = ((parent?.width?.takeIf { it > 0 } ?: 700) * ratio).toInt().coerceIn(min, max)
            return java.awt.Dimension(width, base.height)
        }
        override fun paintComponent(graphics: java.awt.Graphics) {
            val g = graphics.create() as java.awt.Graphics2D
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g.color = primary; g.fillRect(0, 0, width, height)
            // 제목·상태 글자와 겹치지 않게 오른쪽 가운데에 작게 — 좁은 패널에서는 생략
            if (width < 220) { g.dispose(); return }
            g.color = Color(255, 255, 255, 30); g.stroke = BasicStroke(7f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND)
            g.translate(width - 118, (height * 0.36).toInt()); g.scale(0.62, 0.62)
            val x = 0; val y = 0
            g.drawLine(x + 80, y + 40, x + 10, y + 170); g.drawLine(x + 160, y + 170, x + 90, y + 40); g.drawLine(x + 25, y + 205, x + 145, y + 205)
            g.drawOval(x + 63, y + 8, 44, 44); g.drawOval(x - 22, y + 178, 44, 44); g.drawOval(x + 148, y + 178, 44, 44)
            g.dispose()
        }
    }.apply { isOpaque = true; layout = javax.swing.BoxLayout(this, javax.swing.BoxLayout.Y_AXIS); border = BorderFactory.createEmptyBorder(26, 26, 22, 22) }

    private fun html(title: String, detail: String, detailColor: String) =
        "<html><b style='font-size:13pt'>$title</b><br><span style='color:$detailColor'>$detail</span></html>"

    /** 큰 열기 버튼. dark=true 는 주 동작(짙은 바탕), false 는 흰 바탕 + 테두리. */
    fun actionTile(title: String, detail: String, dark: Boolean, badge: String? = null): JButton = object : JButton(html(title, detail, if (dark) "#a1a1aa" else "#71717a")) {
        override fun getMaximumSize() = java.awt.Dimension(Int.MAX_VALUE, preferredSize.height)
        override fun paintComponent(graphics: java.awt.Graphics) {
            val g = graphics.create() as java.awt.Graphics2D
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g.color = when {
                dark && model.isRollover -> inkHover
                dark -> ink
                model.isRollover -> DesktopBrand.hover
                else -> Color.WHITE
            }
            g.fillRoundRect(1, 1, width - 2, height - 2, SURFACE_ARC, SURFACE_ARC)
            g.color = if (hasFocus()) DesktopBrand.primary else if (dark) DesktopBrand.ink else DesktopBrand.border
            g.stroke = BasicStroke(if (hasFocus()) 2f else 1f)
            g.drawRoundRect(1, 1, width - 3, height - 3, SURFACE_ARC, SURFACE_ARC)
            if (badge != null) {
                g.font = DesktopBrand.small.deriveFont(11f); val fm = g.fontMetrics
                val w = fm.stringWidth(badge) + 12; val h = fm.height + 2; val bx = width - w - 16; val by = (height - h) / 2
                g.color = if (dark) Color(0x52, 0x52, 0x5b) else DesktopBrand.border; g.drawRoundRect(bx, by, w, h, 8, 8)
                g.color = if (dark) Color(0xd4, 0xd4, 0xd8) else DesktopBrand.muted; g.drawString(badge, bx + 6, by + fm.ascent + 1)
            }
            g.dispose(); super.paintComponent(graphics)
        }
    }.apply {
        setUI(BasicButtonUI()); font = DesktopBrand.body; foreground = if (dark) Color.WHITE else DesktopBrand.text
        horizontalAlignment = javax.swing.SwingConstants.LEFT; iconTextGap = 12
        border = BorderFactory.createEmptyBorder(12, 16, 12, if (badge != null) 72 else 16)
        isContentAreaFilled = false; isOpaque = false; isFocusPainted = false; isRolloverEnabled = true
        cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
        alignmentX = java.awt.Component.LEFT_ALIGNMENT
    }

    /** 설정 목록 한 줄 — 왼쪽 이름, 오른쪽 보조 값(계정명·버전 등), 아래 옅은 구분선. */
    fun listRow(title: String, value: String? = null, valueColor: Color = muted): JButton = object : JButton(title) {
        override fun getMaximumSize() = java.awt.Dimension(Int.MAX_VALUE, preferredSize.height)
        override fun paintComponent(graphics: java.awt.Graphics) {
            val g = graphics.create() as java.awt.Graphics2D
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON)
            if (model.isRollover || hasFocus()) { g.color = DesktopBrand.hover; g.fillRoundRect(0, 0, width, height - 1, CONTROL_ARC, CONTROL_ARC) }
            g.color = divider; g.drawLine(0, height - 1, width, height - 1)
            if (!value.isNullOrBlank()) {
                g.font = DesktopBrand.small; val fm = g.fontMetrics
                g.color = valueColor; g.drawString(value, width - fm.stringWidth(value) - 8, (height + fm.ascent - fm.descent) / 2)
            }
            g.dispose(); super.paintComponent(graphics)
        }
    }.apply {
        setUI(BasicButtonUI()); font = DesktopBrand.body.deriveFont(13f); foreground = DesktopBrand.text
        horizontalAlignment = javax.swing.SwingConstants.LEFT
        border = BorderFactory.createEmptyBorder(10, 8, 10, 8)
        isContentAreaFilled = false; isOpaque = false; isFocusPainted = false; isRolloverEnabled = true
        cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
        alignmentX = java.awt.Component.LEFT_ALIGNMENT
    }

    fun configure() {
        runCatching { UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName()) }
        UIManager.getDefaults().keys().toList().filter { it.toString().endsWith(".font") }
            .forEach { UIManager.put(it, FontUIResource(body)) }
        UIManager.put("OptionPane.yesButtonText", "확인")
        UIManager.put("OptionPane.noButtonText", "취소")
        UIManager.put("OptionPane.cancelButtonText", "취소")
        UIManager.put("OptionPane.okButtonText", "확인")
        UIManager.put("Button.disabledText", muted)
    }

    fun icon(size: Int, connected: Boolean? = null): BufferedImage =
        BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB).also { image ->
            image.createGraphics().apply {
                setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                scale(size / 64.0, size / 64.0)
                color = primary; fillRoundRect(2, 2, 60, 60, 16, 16)
                color = Color.WHITE; stroke = BasicStroke(7f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND)
                drawLine(20, 43, 20, 24); drawLine(20, 24, 44, 24); drawLine(20, 36, 39, 36)
                fillOval(13, 36, 14, 14); fillOval(37, 17, 14, 14)
                if (connected != null) {
                    color = Color.WHITE; fillOval(43, 43, 20, 20)
                    color = if (connected) success else attention; fillOval(46, 46, 14, 14)
                }
                dispose()
            }
        }
}
