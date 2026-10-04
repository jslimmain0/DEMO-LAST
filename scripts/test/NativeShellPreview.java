import com.flowlink.desktop.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.support.GenericApplicationContext;
import org.mockito.Mockito;
import javax.swing.*;
import java.awt.*;
import java.nio.file.*;

/** Actual Swing rendering with mock connection states; never starts authentication, networking or installers. */
public class NativeShellPreview {
 public static void main(String[] args) throws Exception {
  Thread.setDefaultUncaughtExceptionHandler((thread,error)->{error.printStackTrace();System.exit(1);});
  if(args.length>1 && args[1].equals("--show-home")){showHome();return;}
  Path output=Path.of(args[0]); Files.createDirectories(output);
  Path fixture=Files.createTempDirectory("flowlink-shell-preview-");
  try(DesktopSession session=new DesktopSession(fixture.toString(),18999)) {
   var context=new GenericApplicationContext();context.refresh();
   var remote=Mockito.mock(DesktopConnection.class);
   var tray=new DesktopTray(session,new ObjectMapper(),context,remote,false,false);
   SwingUtilities.invokeAndWait(()->{
    DesktopBrand.INSTANCE.configure();
    for(String scenario:new String[]{"saved","no-server","auth-waiting"}) {
     String server=scenario.equals("no-server")?"":"https://flowlink.long-company-development-environment.example.internal/company/team";
     Mockito.when(remote.view()).thenReturn(new DesktopConnection.View(server,scenario.equals("saved")?"https://company.example.internal/mcp":"",scenario.equals("saved")?"company-user":null,scenario.equals("saved")));
     for(String screen:new String[]{"Welcome","Login","Connect"}) {
      if(scenario.equals("auth-waiting")&&!screen.equals("Login")) continue;
      try {
       var method=DesktopTray.class.getDeclaredMethod("build"+screen+"Dialog");method.setAccessible(true);
       var dialog=(JDialog)method.invoke(tray);dialog.pack();
       if(scenario.equals("auth-waiting")) applyWaiting(dialog.getContentPane());
       int naturalHeight=dialog.getContentPane().getHeight();
       for(int[] size:new int[][]{{700,naturalHeight},{520,naturalHeight},{520,380}}) {
        int width=size[0];String suffix=width+(size[1]==380?"x380":"");
        var panel=dialog.getContentPane();panel.setSize(width,size[1]);
        NativeUiPreview.layout(panel);NativeUiPreview.scrollTop(panel);NativeUiPreview.layout(panel);
        NativeUpdatePreview.capture(panel,output.resolve(scenario+"-"+screen.toLowerCase()+"-"+suffix+".png"));
        NativeUiPreview.scrollBottom(panel);NativeUiPreview.layout(panel);
        NativeUpdatePreview.capture(panel,output.resolve(scenario+"-"+screen.toLowerCase()+"-"+suffix+"-bottom.png"));
       }
       dialog.setSize(520,380);dialog.validate();
       var minimum=dialog.getContentPane();
       NativeUiPreview.layout(minimum);NativeUiPreview.scrollTop(minimum);NativeUiPreview.layout(minimum);
       NativeUpdatePreview.capture(minimum,output.resolve(scenario+"-"+screen.toLowerCase()+"-window520x380.png"));
       NativeUiPreview.scrollBottom(minimum);NativeUiPreview.layout(minimum);
       NativeUpdatePreview.capture(minimum,output.resolve(scenario+"-"+screen.toLowerCase()+"-window520x380-bottom.png"));
       dialog.dispose();
      }catch(Exception e){throw new RuntimeException(e);}
     }
    }
   });context.close();
  }
  try(var paths=Files.walk(fixture)){for(Path path:paths.sorted(java.util.Comparator.reverseOrder()).toList())Files.delete(path);}
  System.out.println("Native home/login/MCP render PASS: mock saved/no-server/auth-waiting, 700/520 top/bottom; no auth actions");System.exit(0);
 }
 static void showHome() throws Exception {
  Path fixture=Files.createTempDirectory("flowlink-visible-home-preview-");
  DesktopSession session=new DesktopSession(fixture.toString(),18999);
  var context=new GenericApplicationContext();context.refresh();
  var remote=Mockito.mock(DesktopConnection.class);
  Mockito.when(remote.view()).thenReturn(new DesktopConnection.View("https://company.example.internal","https://company.example.internal/mcp","company-user",true));
  var tray=new DesktopTray(session,new ObjectMapper(),context,remote,false,false);
  SwingUtilities.invokeAndWait(()->{try {
   DesktopBrand.INSTANCE.configure();var method=DesktopTray.class.getDeclaredMethod("buildWelcomeDialog");method.setAccessible(true);
   JDialog dialog=(JDialog)method.invoke(tray);dialog.pack();disableActions(dialog.getContentPane(),dialog);
   dialog.addWindowListener(new java.awt.event.WindowAdapter(){public void windowClosed(java.awt.event.WindowEvent event){
    session.close();context.close();try(var paths=Files.walk(fixture)){for(Path path:paths.sorted(java.util.Comparator.reverseOrder()).toList())Files.delete(path);}catch(Exception ignored){}System.exit(0);
   }});dialog.setLocationRelativeTo(null);dialog.setVisible(true);
  }catch(Exception e){throw new RuntimeException(e);}});
 }
 static void disableActions(Container parent,JDialog dialog) {
  for(Component c:parent.getComponents()){
   if(c instanceof JButton button){for(var action:button.getActionListeners())button.removeActionListener(action);if(button.getText().equals("닫기"))button.addActionListener(e->dialog.dispose());}
   if(c instanceof Container nested)disableActions(nested,dialog);
  }
 }
 static void applyWaiting(Container parent) {
  for(Component c:parent.getComponents()) {
   if(c instanceof JTextField field && "GitHub 인증 코드".equals(field.getAccessibleContext().getAccessibleName())) {
    field.setText("ABCD-EFGH");field.getParent().setVisible(true);
   }
   if(c instanceof JTextArea area && area.getText().equals("브라우저에서 회사 계정을 인증합니다.")) area.setText("브라우저에서 인증 코드를 승인하세요.");
   if(c instanceof JButton button && button.getText().equals("로그인 시작")) button.setEnabled(false);
   if(c instanceof JButton button && (button.getText().equals("코드 복사")||button.getText().equals("인증 페이지 열기"))) button.setEnabled(true);
   if(c instanceof Container nested) applyWaiting(nested);
  }
 }
}
