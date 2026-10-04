import com.flowlink.desktop.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.support.GenericApplicationContext;
import org.mockito.Mockito;
import javax.swing.*;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.nio.file.*;
import javax.imageio.ImageIO;

/** Mocked updater state only: no HTTP, installer, shutdown or MCP actions. */
public class NativeUpdatePreview {
 public static void main(String[] args) throws Exception {
  Thread.setDefaultUncaughtExceptionHandler((thread,error)->{error.printStackTrace();System.exit(1);});
  Path output=Path.of(args[0]); Files.createDirectories(output);
  Path fixture=Files.createTempDirectory("flowlink-update-preview-");
  try (DesktopSession session=new DesktopSession(fixture.toString(),18999)) {
   GenericApplicationContext context=new GenericApplicationContext();
   DesktopUpdateService updater=Mockito.mock(DesktopUpdateService.class);
   context.getBeanFactory().registerSingleton("desktopUpdateService",updater); context.refresh();
   ObjectMapper mapper=new ObjectMapper();
   DesktopTray tray=new DesktopTray(session,mapper,context,new DesktopConnection(session,mapper,event->{}),false,false);
   SwingUtilities.invokeAndWait(()->{
    DesktopBrand.INSTANCE.configure();
    for(String phase:new String[]{"available","ready"}) {
     Mockito.when(updater.view()).thenReturn(new DesktopUpdateService.View(phase,"0.3.4","0.3.10",123456L,123456L,
       phase.equals("ready")?"파일 검증을 마쳤습니다. 설치하면 앱과 Mock 수신이 잠시 중단됩니다.":"새 업데이트가 있습니다.",
       "긴 릴리스 안내: 개인 작업을 유지하면서 팀 작업의 실행 위치와 환경 선택을 개선했습니다.\n".repeat(12)));
     try {
      var method=DesktopTray.class.getDeclaredMethod("buildUpdateDialog"); method.setAccessible(true);
      JDialog dialog=(JDialog)method.invoke(tray);
      for(int width:new int[]{700,520}) {
       dialog.pack(); Container panel=dialog.getContentPane(); panel.setSize(width,600);
       NativeUiPreview.layout(panel); NativeUiPreview.scrollTop(panel); NativeUiPreview.layout(panel);
       capture(panel,output.resolve(phase+"-"+width+".png"));
       NativeUiPreview.scrollBottom(panel); NativeUiPreview.layout(panel);
       capture(panel,output.resolve(phase+"-"+width+"-bottom.png"));
      }
      dialog.dispose();
     }catch(Exception error){throw new RuntimeException(error);}
    }
   }); context.close();
  }
  try(var paths=Files.walk(fixture)){for(Path path:paths.sorted(java.util.Comparator.reverseOrder()).toList())Files.delete(path);}
  System.out.println("Updater available/ready actual Swing render PASS (mock state, no installation)"); System.exit(0);
 }
 static void capture(Container panel,Path file)throws Exception {
  NativeUiPreview.assertBounds(panel);
  var image=new BufferedImage(panel.getWidth(),panel.getHeight(),BufferedImage.TYPE_INT_RGB);
  var graphics=image.createGraphics();panel.printAll(graphics);graphics.dispose();ImageIO.write(image,"png",file.toFile());
 }
}
