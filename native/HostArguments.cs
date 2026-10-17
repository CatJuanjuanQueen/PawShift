using System;
using System.Collections;

// JavaScriptSerializer can return ArrayList or object[] depending on the target type.
// All native calls use this conversion rather than casting the deserialized value.
internal static class HostArguments {
 public static object[] Read(object value) {
  var list=value as IList;
  if(list==null)throw new ArgumentException("本地操作参数必须是 JSON 数组");
  var result=new object[list.Count];
  list.CopyTo(result,0);
  return result;
 }
}
