using System;
using System.IO;
using System.Drawing;
using System.Diagnostics;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

class PawShift : Form {
 const string Origin="https://pawshift.local/";
 readonly JavaScriptSerializer json=new JavaScriptSerializer {MaxJsonLength=16*1024*1024};
 WebView2 view=new WebView2 {Dock=DockStyle.Fill};
 readonly System.Windows.Forms.Timer idleTimer=new System.Windows.Forms.Timer {Interval=10000};
 readonly string root=AppDomain.CurrentDomain.BaseDirectory;
 readonly string data;
 Process backend;StreamWriter backendInput;NotifyIcon tray;bool quitting,closed,ready;string closeBehavior="quit";
 string lastSnapshot,pendingPage;bool test,pageLoaded;int port;
 public PawShift(string dataDirectory,bool testMode,int debugPort){
  data=dataDirectory;test=testMode;port=debugPort;Text="PawShift";Width=1280;Height=860;MinimumSize=new Size(720,500);
  Icon=new Icon(Path.Combine(root,"media","icon.ico"));Controls.Add(view);
  var menu=new MenuStrip();var file=new ToolStripMenuItem("文件");
  file.DropDownItems.Add("新建任务",null,(s,e)=>Navigate("new"));file.DropDownItems.Add("项目管理",null,(s,e)=>Navigate("projects"));file.DropDownItems.Add("设置",null,(s,e)=>Navigate("settings"));file.DropDownItems.Add("退出",null,(s,e)=>Exit());menu.Items.Add(file);Controls.Add(menu);MainMenuStrip=menu;
  tray=new NotifyIcon {Icon=Icon,Text="PawShift",Visible=true};
  idleTimer.Tick+=(s,e)=>{idleTimer.Stop();if(Visible&&WindowState!=FormWindowState.Minimized)return;if(view!=null){ready=false;Controls.Remove(view);view.Dispose();view=null;lastSnapshot=null;}};
  var context=new ContextMenuStrip();context.Items.Add("打开PawShift",null,(s,e)=>Restore());context.Items.Add("新建任务",null,(s,e)=>Navigate("new"));context.Items.Add("暂停当前任务和调度",null,(s,e)=>Command("scheduler.pause"));context.Items.Add("继续执行",null,(s,e)=>Command("scheduler.execute"));context.Items.Add("恢复检查",null,(s,e)=>Navigate("recovery"));context.Items.Add("退出",null,(s,e)=>Exit());tray.ContextMenuStrip=context;tray.DoubleClick+=(s,e)=>Restore();
  Shown+=async(s,e)=>{try{await Initialize();}catch(Exception error){File.WriteAllText(Path.Combine(data,"webview-startup-error.log"),error.ToString());MessageBox.Show(this,"启动失败："+error.Message+"\n请确认已安装 Microsoft Edge WebView2 Runtime。","PawShift");Exit();}};
  Resize+=async(s,e)=>{bool active=Visible&&WindowState!=FormWindowState.Minimized;if(!ready){if(active&&view==null)Restore();return;}Send(new {kind="visibility",visible=active});view.Visible=active;if(active){idleTimer.Stop();view.CoreWebView2.Resume();}else{idleTimer.Start();await view.CoreWebView2.TrySuspendAsync();}};
  FormClosing+=async(s,e)=>{
   if(closed)return;e.Cancel=true;
   if(!quitting&&closeBehavior=="tray"){Hide();if(view!=null)view.Visible=false;Send(new {kind="visibility",visible=false});idleTimer.Start();if(ready)await view.CoreWebView2.TrySuspendAsync();return;}
   if(quitting)return;quitting=true;Send(new {kind="close"});
   if(backend!=null){await Task.Run(()=>backend.WaitForExit(15000));if(!backend.HasExited){MessageBox.Show(this,"后台尚未完成保存，请稍后再次退出。","PawShift");quitting=false;return;}}
   closed=true;idleTimer.Dispose();tray.Dispose();if(view!=null)view.Dispose();Close();
  };
 }
 async Task Initialize(){
  pageLoaded=false;
  if(view==null){view=new WebView2 {Dock=DockStyle.Fill};Controls.Add(view);view.BringToFront();MainMenuStrip.BringToFront();}
  var options=new CoreWebView2EnvironmentOptions();if(test&&port>0)options.AdditionalBrowserArguments="--remote-debugging-port="+port;
  var env=await CoreWebView2Environment.CreateAsync(null,Path.Combine(data,"WebView2"),options);
  await view.EnsureCoreWebView2Async(env);var core=view.CoreWebView2;
  core.Settings.AreDevToolsEnabled=test;core.Settings.AreDefaultContextMenusEnabled=false;core.Settings.IsStatusBarEnabled=false;core.Settings.AreHostObjectsAllowed=false;
  core.SetVirtualHostNameToFolderMapping("pawshift.local",Path.Combine(root,"media"),CoreWebView2HostResourceAccessKind.DenyCors);
  await core.AddScriptToExecuteOnDocumentCreatedAsync(File.ReadAllText(Path.Combine(root,"webview-bridge.js")));
  core.NavigationStarting+=(s,e)=>{if(e.Uri!=Origin+"index.html")e.Cancel=true;};
  core.NavigationCompleted+=(s,e)=>{pageLoaded=e.IsSuccess;if(pageLoaded&&pendingPage!=null){core.PostWebMessageAsJson(json.Serialize(new {kind="navigate",data=new {page=pendingPage}}));pendingPage=null;}};
  core.NewWindowRequested+=(s,e)=>{e.Handled=true;};core.PermissionRequested+=(s,e)=>{e.State=CoreWebView2PermissionState.Deny;};core.DownloadStarting+=(s,e)=>{e.Cancel=true;};
  core.AddWebResourceRequestedFilter("*",CoreWebView2WebResourceContext.All);
  core.WebResourceRequested+=(s,e)=>{var uri=new Uri(e.Request.Uri);if(uri.Host!="pawshift.local"||uri.Scheme!="https")e.Response=env.CreateWebResourceResponse(new MemoryStream(),403,"Blocked","");};
  core.WebMessageReceived+=(s,e)=>{if(e.Source!=Origin+"index.html")return;try{var m=json.Deserialize<Dictionary<string,object>>(e.WebMessageAsJson);string kind=(string)m["kind"];if(kind=="command")Send(m);else if(test&&kind=="test-close")Exit();else if(test&&kind=="test-minimize")WindowState=FormWindowState.Minimized;else if(test&&kind=="test-restore")Restore();}catch{}};
  if(backend==null){
  var info=new ProcessStartInfo(Path.Combine(root,"runtime","node.exe")){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=root,Arguments="--max-old-space-size=128 \""+Path.Combine(root,"backend","webview-backend.js")+"\" \""+data+"\"",StandardOutputEncoding=System.Text.Encoding.UTF8,StandardErrorEncoding=System.Text.Encoding.UTF8};
  backend=new Process {StartInfo=info,EnableRaisingEvents=true};
  backend.OutputDataReceived+=(s,e)=>{if(e.Data!=null&&!IsDisposed)BeginInvoke((Action)(()=>Receive(e.Data)));};
  backend.ErrorDataReceived+=(s,e)=>{if(e.Data!=null)File.AppendAllText(Path.Combine(data,"webview-backend.log"),e.Data+Environment.NewLine);};
  backend.Exited+=(s,e)=>{if(!quitting&&!IsDisposed)BeginInvoke((Action)(()=>{MessageBox.Show(this,"任务后台已退出，请重新打开软件。","PawShift");Exit();}));};
  backend.Start();backendInput=new StreamWriter(backend.StandardInput.BaseStream,new System.Text.UTF8Encoding(false)){AutoFlush=true};backend.BeginOutputReadLine();backend.BeginErrorReadLine();}
  ready=true;core.Navigate(Origin+"index.html");if(test)Restore();
 }
 void Send(object value){if(backendInput==null||backend.HasExited)return;backendInput.WriteLine(json.Serialize(value));}
 void Receive(string line){
  try{var m=json.Deserialize<Dictionary<string,object>>(line);string kind=(string)m["kind"];
   if(kind=="response"&&Convert.ToInt32(m["id"])==-1){bool ok=(bool)m["ok"];string text=ok?"调度状态已更新":(string)m["error"];if(ok&&m["data"] is Dictionary<string,object>){var result=(Dictionary<string,object>)m["data"];if(result.ContainsKey("message"))text=(string)result["message"];if(result.ContainsKey("status")&&(string)result["status"]=="blocked")ok=false;}tray.ShowBalloonTip(5000,"PawShift",text,ok?ToolTipIcon.Info:ToolTipIcon.Warning);return;}
   if(kind=="host"){object result=null;string error=null;try{result=Host((string)m["method"],HostArguments.Read(m["args"]));}catch(Exception ex){error=ex.Message;}Send(new {kind="hostResult",id=m["id"],data=result,error=error});return;}
   if(kind=="snapshot"){var snap=(Dictionary<string,object>)m["data"];var settings=(Dictionary<string,object>)snap["settings"];closeBehavior=(string)settings["closeBehavior"];lastSnapshot=line;if(!Visible||WindowState==FormWindowState.Minimized)return;}
   if(ready&&(kind=="response"||kind=="snapshot"))view.CoreWebView2.PostWebMessageAsJson(line);
  }catch(Exception error){File.AppendAllText(Path.Combine(data,"webview-host.log"),error.ToString()+Environment.NewLine);}
 }
 object Host(string method,object[] args){
  // Test fixtures only supply OS-dialog answers. Parsing and the entire UI/backend/native bridge stay real.
  Dictionary<string,object> fixture=null;
  var fixturePath=Path.Combine(data,"native-test-fixture.json");
  if(test&&File.Exists(fixturePath)){
   fixture=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(fixturePath));
   File.AppendAllText(Path.Combine(data,"native-host-calls.jsonl"),json.Serialize(new {method=method,argumentCount=args.Length})+Environment.NewLine);
  }
  switch(method){
   case "showApproval":Navigate("queue");return null;
   case "openLogin":var loginUri=new Uri((string)args[0]);if(loginUri.Scheme!="https"||(loginUri.Host!="auth.openai.com"&&loginUri.Host!="auth0.openai.com"&&loginUri.Host!="chatgpt.com"))throw new Exception("登录地址无效");Process.Start(new ProcessStartInfo(loginUri.AbsoluteUri){UseShellExecute=true});return null;
   case "openCodex":Process.Start(new ProcessStartInfo("vscode://openai.chatgpt/"){UseShellExecute=true});return null;
   case "openGpt":Process.Start(new ProcessStartInfo("codex://"){UseShellExecute=true});return null;
   case "clipboard":Clipboard.SetText((string)args[0]);return null;
   case "confirm":if(fixture!=null)return fixture.ContainsKey("confirm")&&fixture["confirm"] is bool&&(bool)fixture["confirm"];return MessageBox.Show(this,(string)args[1],(string)args[0],MessageBoxButtons.OKCancel,MessageBoxIcon.Question,MessageBoxDefaultButton.Button2)==DialogResult.OK;
   case "chooseDirectory":if(fixture!=null)return TestPath(fixture,"projectDirectory");using(var d=new FolderBrowserDialog()){d.Description="关联本地项目";return d.ShowDialog(this)==DialogResult.OK?d.SelectedPath:null;}
   case "chooseCodex":case "chooseBackup":if(fixture!=null)return TestPath(fixture,method=="chooseCodex"?"codexPath":"backupPath");using(var d=new OpenFileDialog()){d.Filter=method=="chooseCodex"?"Windows 可执行文件|*.exe":"SQLite 备份|*.db";return d.ShowDialog(this)==DialogResult.OK?d.FileName:null;}
   case "saveFile":if(fixture!=null){var exportPath=TestPath(fixture,"exportPath");if(exportPath==null)return null;File.WriteAllText(exportPath,(string)args[1]);return exportPath;}using(var d=new SaveFileDialog()){d.FileName=(string)args[0];d.Filter="JSON|*.json";if(d.ShowDialog(this)!=DialogResult.OK)return null;File.WriteAllText(d.FileName,(string)args[1]);return d.FileName;}
   case "openDataDirectory":if((string)args[0]!=data)throw new Exception("无效数据目录");if(fixture!=null)return null;Process.Start(new ProcessStartInfo(data){UseShellExecute=true});return null;
   default:throw new Exception("未知本地操作");
  }
 }
 string TestPath(Dictionary<string,object> fixture,string key){
  if(!test)throw new Exception("测试路径仅限测试模式");
  if(!fixture.ContainsKey(key)||fixture[key]==null)return null;
  var path=Path.GetFullPath((string)fixture[key]);var scope=Path.GetFullPath(Path.Combine(data,".."))+Path.DirectorySeparatorChar;
  if(!path.StartsWith(scope,StringComparison.OrdinalIgnoreCase))throw new Exception("测试路径超出隔离目录");
  return path;
 }
 async void Restore(){idleTimer.Stop();Show();WindowState=FormWindowState.Normal;Activate();if(view==null){try{await Initialize();}catch(Exception error){MessageBox.Show(this,error.Message,"恢复界面失败");return;}}view.Visible=true;if(ready){view.CoreWebView2.Resume();Send(new {kind="visibility",visible=true});if(lastSnapshot!=null)view.CoreWebView2.PostWebMessageAsJson(lastSnapshot);}}
 void Navigate(string page){pendingPage=page;Restore();if(ready&&pageLoaded){view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new {kind="navigate",data=new {page=page}}));pendingPage=null;}}
 void Command(string type){if(type=="scheduler.execute")Navigate("queue");Send(new {kind="command",id=-1,message=new {type=type,commandId=Guid.NewGuid().ToString(),payload=new {}}});}
 void Exit(){quitting=false;closeBehavior="quit";Close();}
 [STAThread] static void Main(string[] args){
  string data=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),"PawShift");bool test=false;int port=0;
  foreach(var arg in args){if(arg.StartsWith("--pawshift-data-dir="))data=Path.GetFullPath(arg.Substring(20));if(arg=="--pawshift-test")test=true;if(arg.StartsWith("--debug-port="))port=int.Parse(arg.Substring(13));}
  Directory.CreateDirectory(data);bool created;using(var mutex=new Mutex(true,"Local\\PawShift-WebView2-"+Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(data)).Replace('\\','_'),out created)){
   if(!test)foreach(var process in Process.GetProcessesByName("PawShift")){if(process.Id!=Process.GetCurrentProcess().Id){MessageBox.Show("请先在系统托盘退出旧版PawShift，再启动此版本，避免两个版本同时访问任务数据。","PawShift");return;}}
   if(!created){MessageBox.Show("PawShift已在运行，请从系统托盘打开。","PawShift");return;}
   Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new PawShift(data,test,port));
  }
 }
}
