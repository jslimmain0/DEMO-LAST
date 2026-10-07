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
