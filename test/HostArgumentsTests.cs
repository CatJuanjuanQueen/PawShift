using System;
using System.Collections;
using System.Collections.Generic;
using System.Web.Script.Serialization;

class HostArgumentsTests {
 static int passed=0;
 static readonly JavaScriptSerializer json=new JavaScriptSerializer();
 static void Check(bool valid,string name){if(!valid)throw new Exception(name);passed++;}
 static object[] Parse(string text){return HostArguments.Read(json.Deserialize<Dictionary<string,object>>(text)["args"]);}
 static void Invalid(object value){bool rejected=false;try{HostArguments.Read(value);}catch(ArgumentException){rejected=true;}Check(rejected,"Reject malformed argument container");}
 static int Main(){
  try{
   var raw=json.Deserialize<Dictionary<string,object>>("{\"args\":[]}")["args"];
   bool reproduced=false;try{var old=(object[])raw;}catch(InvalidCastException){reproduced=true;}
   Check(reproduced&&raw is ArrayList,"Reproduce the original ArrayList cast failure");
   Check(Parse("{\"args\":[]}").Length==0,"No-argument calls such as chooseDirectory and showApproval");
   var confirm=Parse("{\"args\":[\"允许 AGENT 执行项目任务\",\"D:\\\\项目\\\\测试\\n仅当前项目\"]}");
   Check(confirm.Length==2&&(string)confirm[0]=="允许 AGENT 执行项目任务"&&((string)confirm[1]).Contains("\n"),"Confirmation keeps Unicode and multiline text");
   var save=Parse("{\"args\":[\"诊断.json\",\"{\\\"safe\\\":true}\"]}");
   Check((string)save[0]=="诊断.json"&&(string)save[1]=="{\"safe\":true}","Save dialog arguments keep serialized content");
   Check((string)HostArguments.Read(new object[]{"existing-array"})[0]=="existing-array","Existing object arrays remain supported");
   var values=Parse("{\"args\":[null,true,42,{\"name\":\"test\"},[\"nested\"]]}");
   Check(values.Length==5&&values[0]==null&&(bool)values[1]&&(int)values[2]==42&&values[3] is Dictionary<string,object>&&values[4] is ArrayList,"Preserve JSON element types");
   Invalid(null);Invalid("not an array");Invalid(new Dictionary<string,object>());
   Console.WriteLine("{\"passed\":true,\"cases\":"+passed+",\"originalBugReproduced\":true}");return 0;
  }catch(Exception error){Console.Error.WriteLine(error);return 1;}
 }
}
