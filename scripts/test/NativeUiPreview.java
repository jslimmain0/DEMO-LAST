import com.flowlink.desktop.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.support.GenericApplicationContext;
import javax.swing.*;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.nio.file.*;
import javax.imageio.ImageIO;

/** Renders actual Swing widgets. No visible windows, service startup, login, IDE registration or MCP calls. */
public class NativeUiPreview {
    public static void main(String[] args) throws Exception {
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> { error.printStackTrace(); System.exit(1); });
        Path output = Path.of(args[0]); Files.createDirectories(output);
        Path state = Files.createTempDirectory("flowlink-native-preview-");
        Files.writeString(state.resolve("server-url.txt"), "https://flowlink.long-company-development-environment.example.internal/company/team");
        DesktopSession session = new DesktopSession(state.toString(), 18999);
        var context = new GenericApplicationContext();
        context.refresh();
        var mapper = new ObjectMapper();
        var connection = new DesktopConnection(session, mapper, event -> {});
        var tray = new DesktopTray(session, mapper, context, connection, false, false);
        SwingUtilities.invokeAndWait(() -> {
            DesktopBrand.INSTANCE.configure();
            for (String name : new String[]{"Welcome", "Login", "Status", "Connect", "Update"}) {
                try {
                    var method = DesktopTray.class.getDeclaredMethod("build" + name + "Dialog"); method.setAccessible(true);
                    var dialog = (JDialog) method.invoke(tray);
                    for (int width : new int[]{700, 520}) {
                        dialog.pack();
                        var panel = dialog.getContentPane();
                        panel.setSize(width, panel.getHeight()); layout(panel);
                        scrollTop(panel); layout(panel);
                        var image = new BufferedImage(panel.getWidth(), panel.getHeight(), BufferedImage.TYPE_INT_RGB);
                        var graphics = image.createGraphics(); panel.printAll(graphics); graphics.dispose();
                        ImageIO.write(image, "png", output.resolve(name.toLowerCase() + "-" + width + ".png").toFile());
                        assertBounds(panel);
                        scrollBottom(panel); layout(panel);
                        graphics = image.createGraphics(); panel.printAll(graphics); graphics.dispose();
                        ImageIO.write(image, "png", output.resolve(name.toLowerCase() + "-" + width + "-bottom.png").toFile());
                        assertBounds(panel);
                    }
                    dialog.dispose();
                } catch (Exception error) { throw new RuntimeException(error); }
            }
        });
        session.close(); context.close();
        // Only this process's temporary fixture is removed; no real user/app data is opened.
        try (var files = Files.walk(state)) {
            for (Path file : files.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(file);
        }
        System.out.println("Native UI component render: PASS (not Windows tray interaction)");
        System.exit(0);
    }
    static void layout(Container component) {
        for (int pass = 0; pass < 4; pass++) { invalidateTree(component); layoutTree(component); }
    }
    static void invalidateTree(Container component) { component.invalidate(); for (Component child : component.getComponents()) if (child instanceof Container nested) invalidateTree(nested); }
    static void layoutTree(Container component) { component.doLayout(); for (Component child : component.getComponents()) if (child instanceof Container nested) layoutTree(nested); }
    static void scrollBottom(Container parent) {
        if (parent instanceof JScrollPane pane) pane.getVerticalScrollBar().setValue(pane.getVerticalScrollBar().getMaximum());
        for (Component child : parent.getComponents()) if (child instanceof Container nested) scrollBottom(nested);
    }
    static void scrollTop(Container parent) {
        if (parent instanceof JScrollPane pane) pane.getVerticalScrollBar().setValue(pane.getVerticalScrollBar().getMinimum());
        for (Component child : parent.getComponents()) if (child instanceof Container nested) scrollTop(nested);
    }
    static void assertBounds(Container parent) {
        if (parent instanceof JTextArea text && text.getWidth() > 0 && text.getHeight() > 0) {
            try {
                var end = text.modelToView2D(text.getDocument().getLength());
                if (end != null && end.getMaxY() > text.getHeight() + 1)
                    throw new AssertionError("Text clipped: " + text.getText() + " last line " + end + " height " + text.getHeight());
            } catch (javax.swing.text.BadLocationException error) { throw new AssertionError(error); }
        }
        if (parent instanceof JViewport viewport && viewport.getView() != null && viewport.getView().getWidth() > viewport.getWidth() + 1)
            throw new AssertionError("Horizontal clipping: " + viewport.getView().getSize() + " viewport " + viewport.getSize());
        for (Component child : parent.getComponents()) {
            if (!(parent instanceof JViewport) && child.isVisible() && (child.getX() < 0 || child.getY() < 0 || child.getX() + child.getWidth() > parent.getWidth() + 1 || child.getY() + child.getHeight() > parent.getHeight() + 1))
                throw new AssertionError("Out of bounds: " + child.getClass().getSimpleName() + " " + child.getBounds() + " parent " + parent.getSize());
            if (child.isVisible() && child instanceof Container nested) assertBounds(nested);
        }
    }
}
