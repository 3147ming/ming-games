/*=== CODE_ENGINE_START ===*/
/* ================= 全语言程序化题库（五档：模板 + 随机参数 / 知识点池） =================
   语言键：c / python / java / js / sql / web / all（all = 语言无关）
   知识点池格式：[问题, 正确答案, '选项1|选项2|选项3|选项4']（四个选项同类相近，含正确答案）
   参数化生成器：返回 {q,a,opts}，答案当场计算，题量 = 模板参数空间（P1-4 逐条标 kb） */
function riN(a,b){return a+Math.floor(Math.random()*(b-a+1));}
function binOf(n,w){var s=n.toString(2);while(w&&s.length<w)s='0'+s;return s;}
function binWrongs(s,n){
  var out=[];
  for(var i=0;i<s.length;i++)out.push(s.slice(0,i)+(s[i]==='1'?'0':'1')+s.slice(i+1));
  return shuffle(out).slice(0,n||3);
}
function hexOf(n){return n.toString(16).toUpperCase();}
/* 位运算的同类候选：保证能凑出 3 个不重复且非负的干扰项 */
function bitCands(a,b,ans){
  var all=[a&b,a|b,a+b,a*b,Math.abs(a-b),a+1,b+1],out=[],seen={};
  seen[ans]=1;
  all.forEach(function(v){if(out.length>=4)return;if(!isFinite(v)||seen[v])return;seen[v]=1;out.push(v);});
  return out;
}
function shiftCands(a,k,ans){
  var all=[a*k,a<<(k+1),a>>k,a+k,a*(k+1),ans+1,ans-1],out=[],seen={};
  seen[ans]=1;
  all.forEach(function(v){if(out.length>=4)return;if(!isFinite(v)||seen[v])return;seen[v]=1;out.push(v);});
  return out;
}
function fact(n){var r=1;for(var i=2;i<=n;i++)r*=i;return r;}
function fibOf(n){var a=1,b=1;for(var i=3;i<=n;i++){var c=a+b;a=b;b=c;}return b;}

var CODE_KB={
all:{
 0:[
  ['1 KB 等于多少字节？','1024','1024|1000|512|2048'],
  ['1 字节（Byte）等于多少位（bit）？','8','8|4|16|32']
 ],
 1:[
  ['逻辑运算 true && false 的结果是？','false','false|true|null|空字符串'],
  ['程序中的变量本质上是什么？','一块有名字的内存空间','一块有名字的内存空间|一个数字|一个函数|一个文件']
 ],
 2:[
  ['位运算符 & 表示什么运算？','按位与','按位与|按位或|按位异或|按位取反'],
  ['一个字节最多能表示多少个不同的值？','256','256|128|255|512']
 ],
 3:[
  ['冒泡排序的平均时间复杂度是？','O(n²)','O(n²)|O(n log n)|O(log n)|O(1)'],
  ['快速排序的平均时间复杂度是？','O(n log n)','O(n log n)|O(n²)|O(log n)|O(n)'],
  ['二分查找的时间复杂度是？','O(log n)','O(log n)|O(n)|O(n log n)|O(1)'],
  ['哈希表理想情况下的查找复杂度是？','O(1)','O(1)|O(log n)|O(n)|O(n²)'],
  ['深度优先搜索（DFS）常用的辅助结构是？','栈','栈|队列|堆|链表'],
  ['广度优先搜索（BFS）常用的辅助结构是？','队列','队列|栈|树|哈希表'],
  ['数组按下标随机访问的复杂度是？','O(1)','O(1)|O(n)|O(log n)|O(n²)'],
  ['归并排序相对冒泡排序的优势是？','平均复杂度更低','平均复杂度更低|不需要额外空间|实现更简单|比较次数恒定'],
  ['递归缺少终止条件通常会导致？','栈溢出','栈溢出|内存泄漏|死循环但不会崩溃|编译失败'],
  ['链表相比数组的优势是？','插入删除不需要移动元素','插入删除不需要移动元素|随机访问更快|占用内存更少|支持下标直接访问']
 ],
 4:[
  ['8 位有符号整数能表示的范围是？','-128 ~ 127','-128 ~ 127|-127 ~ 127|-128 ~ 128|0 ~ 255'],
  ['8 位补码相加产生溢出时，最高位的进位会怎样？','被丢弃','被丢弃|自动扩展到 16 位|触发异常|存入标志位并保留'],
  ['多数语言中 0.1 + 0.2 不等于 0.3，原因是？','二进制无法精确表示 0.1','二进制无法精确表示 0.1|运算顺序错误|编译器缺陷|0.2 被舍入为 0.25'],
  ['面试常问的「时间复杂度」衡量的是什么？','随输入规模增长的趋势','随输入规模增长的趋势|程序运行的确切秒数|代码行数|内存占用字节数']
 ]
},
c:{
 0:[
  ['C 语言中用于声明整型变量的关键字是？','int','int|char|float|double'],
  ['C 语言中用于声明单精度浮点数的关键字是？','float','float|int|double|char'],
  ['C 语言中字符类型 char 通常占几个字节？','1','1|2|4|8'],
  ['C 语言程序的入口函数是？','main','main|start|init|begin'],
  ['C 语言中单行注释用什么符号开头？','//','//|#|/*|--'],
  ['C 语言中 for 循环括号里的三个部分依次是？','初始化;条件;更新','初始化;条件;更新|条件;初始化;更新|更新;条件;初始化|初始化;更新;条件'],
  ['C 语言中 printf 函数的作用是？','格式化输出','格式化输出|读取输入|分配内存|打开文件'],
  ['C 语言中每条语句通常以什么符号结束？','分号 ;','分号 ;|冒号 :|逗号 ,|句号 .']
 ],
 1:[
  ['C 语言中，int a[5] 的合法下标范围是？','0~4','0~4|1~5|0~5|1~4'],
  ['C 语言中 while 条件一开始就为假时，循环体执行几次？','0 次','0 次|1 次|无限次|编译错误'],
  ['C 语言中 break 在循环里的作用是？','立即结束整个循环','立即结束整个循环|跳过本次进入下一次|重新开始循环|结束整个程序'],
  ['C 语言中 continue 的作用是？','跳过本次剩余语句，进入下一次循环','跳过本次剩余语句，进入下一次循环|结束整个循环|结束程序|跳出当前函数'],
  ['C 语言中三目运算符的写法是？','条件 ? 值1 : 值2','条件 ? 值1 : 值2|条件 : 值1 ? 值2|条件 ? 值1 ; 值2|条件 ? 值1 , 值2'],
  ['C 语言中 if 的条件表达式值为 0 时表示？','假','假|真|语法错误|未定义'],
  ['C 语言中 do-while 与 while 的关键区别是？','do-while 至少执行一次','do-while 至少执行一次|while 至少执行一次|两者完全相同|do-while 不能带条件']
 ],
 2:[
  ['C 语言中，取变量 a 的内存地址用哪个运算符？','&a','&a|*a|a.|a->'],
  ['C 语言中，若 p 是整型指针，*p 表示什么？','p 所指向变量的值','p 所指向变量的值|p 自身的内存地址|p 占用的字节数|p 的类型名'],
  ['C 语言中，数组名在表达式中通常等价于什么？','数组首元素的地址','数组首元素的地址|数组的长度|数组最后一个元素|数组的一份副本'],
  ['C 语言中，宏 NULL 通常表示什么？','空指针','空指针|字符串 "0"|未初始化的数组|字符串结束符'],
  ['C 语言中，malloc 申请的内存应当用哪个函数释放？','free','free|delete|clear|release'],
  ['C 语言中，访问结构体变量 s 的成员 x 用哪个写法？','s.x','s.x|s->x|s::x|s[x]'],
  ['C 语言中，访问结构体指针 p 的成员 x 用哪个写法？','p->x','p->x|p.x|*p.x|p::x'],
  ['C 语言中，sizeof 运算符返回的是什么？','占用的字节数','占用的字节数|元素个数|二进制位数|内存地址'],
  ['C 语言中，释放后仍继续使用的指针称为？','悬空指针','悬空指针|野指针|空指针|函数指针'],
  ['C 语言中，对同一块内存连续 free 两次通常会导致？','堆破坏（未定义行为）','堆破坏（未定义行为）|内存自动扩容|编译报错|返回错误码'],
  ['C 语言中，指针变量本身占用的内存大小取决于什么？','平台的字长','平台的字长|它指向的类型|数组长度|编译优化等级'],
  ['C 语言中，二维数组 a[3][4] 中 a[1] 表示什么？','第二行首元素的地址','第二行首元素的地址|第二行第一个元素的值|第一行第二个元素的值|数组总长度']
 ],
 3:[
  ['冒泡排序的平均时间复杂度是？','O(n²)','O(n²)|O(n log n)|O(log n)|O(1)'],
  ['快速排序的平均时间复杂度是？','O(n log n)','O(n log n)|O(n²)|O(log n)|O(n)'],
  ['二分查找的时间复杂度是？','O(log n)','O(log n)|O(n)|O(n log n)|O(1)'],
  ['单链表结点的典型组成是？','数据域 + 指向下一结点的指针','数据域 + 指向下一结点的指针|只有数据域|两个数据域|数据域 + 数组长度'],
  ['栈的访问特点是？','后进先出','后进先出|先进先出|随机访问|按优先级出'],
  ['队列的访问特点是？','先进先出','先进先出|后进先出|随机访问|按大小排序出'],
  ['二叉树前序遍历的顺序是？','根 → 左 → 右','根 → 左 → 右|左 → 根 → 右|左 → 右 → 根|右 → 左 → 根'],
  ['在有序数组中查找目标值，效率更高的是？','二分查找','二分查找|顺序查找|冒泡查找|哈希查找']
 ],
 4:[
  ['C 语言中 int (*fp)(int); 声明的是什么？','指向函数的指针','指向函数的指针|返回指针的函数|整型数组|指向 int 的指针'],
  ['C 语言中 #define 的作用是什么？','预处理阶段的宏替换','预处理阶段的宏替换|定义普通变量|定义函数|引入头文件'],
  ['C 语言中 typedef 的作用是什么？','为已有类型起别名','为已有类型起别名|定义新变量|申请堆内存|声明函数'],
  ['C 语言中 union 的大小通常等于什么？','最大成员的大小','最大成员的大小|所有成员大小之和|最小成员的大小|固定 4 字节'],
  ['结构体按成员最大对齐数对齐，主要目的是什么？','提高内存访问效率','提高内存访问效率|节省内存|兼容旧编译器|方便调试'],
  ['C 语言中 int *p 指向数组元素，执行 p+1 实际前进多少字节？','sizeof(int) 个字节','sizeof(int) 个字节|1 个字节|4 个位|sizeof(int*) 个字节'],
  ['在常见补码平台上，C 语言里 8 位有符号 char 存储 200 会得到什么？','-56','-56|200|56|0'],
  ['C 语言中，无符号数与有符号数比较时，有符号数会怎样？','被转换为无符号数','被转换为无符号数|保持有符号|编译报错|被截断为 0'],
  ['C 语言中，宏 #define SQ(x) x*x 在 SQ(1+2) 展开后是什么？','1+2*1+2','1+2*1+2|(1+2)*(1+2)|9|3*3'],
  ['C 语言中，volatile 关键字的主要作用是？','禁止编译器优化该变量的读写','禁止编译器优化该变量的读写|把变量放入寄存器|声明变量为只读|申请动态内存']
 ]
},
python:{
 0:[
  ['Python 中向控制台输出内容用哪个函数？','print','print|echo|printf|write'],
  ['Python 中单行注释以什么符号开头？','#','#|//|--|/*'],
  ['Python 中定义函数用哪个关键字？','def','def|function|func|lambda'],
  ['Python 中定义列表使用哪对符号？','方括号 []','方括号 []|花括号 {}|圆括号 ()|尖括号 <>'],
  ['Python 中表示布尔真值的字面量是？','True','True|true|TRUE|Yes'],
  ['Python 中缩进的作用是？','表示代码块层级','表示代码块层级|仅为了好看|分隔语句|声明变量'],
  ['Python 3 中 print 属于什么？','内置函数','内置函数|关键字|标准库模块|类']
 ],
 1:[
  ['Python 中 len("hello") 的结果是？','5','5|4|6|报错'],
  ['Python 中 range(5) 生成的整数是？','0,1,2,3,4','0,1,2,3,4|1,2,3,4,5|0,1,2,3,4,5|1,2,3,4'],
  ['Python 中 "abc".upper() 的结果是？','ABC','ABC|abc|Abc|报错'],
  ['Python 中 s="hello"，s[1:3] 的结果是？','el','el|ell|he|lo'],
  ['Python 中 if 之后继续判断分支用哪个关键字？','elif','elif|else if|elseif|otherwise'],
  ['Python 中 for x in [1,2,3] 会循环几次？','3 次','3 次|2 次|4 次|1 次'],
  ['Python 中 int("12") 得到什么？','整数 12','整数 12|字符串 12|浮点数 12|布尔值']
 ],
 2:[
  ['Python 中字典 dict 存储的是什么？','键值对','键值对|有序整数|仅字符串|集合元素'],
  ['Python 中 [x*x for x in range(3)] 的结果是？','[0, 1, 4]','[0, 1, 4]|[0, 1, 2]|[1, 4, 9]|[0, 4, 9]'],
  ['Python 中捕获异常用哪个关键字？','except','except|catch|rescue|handler'],
  ['Python 中判断元素是否在列表里用哪个运算符？','in','in|has|contains|within'],
  ['Python 中 tuple 与 list 的主要区别是？','tuple 创建后不可修改','tuple 创建后不可修改|tuple 不能遍历|tuple 只能存数字|两者没有区别'],
  ['Python 中 set 的主要特点是？','元素不重复','元素不重复|元素有序|只能存字符串|不可遍历'],
  ['Python 中 d={"a":1}，d["a"] 的值是？','1','1|"a"|None|报错']
 ],
 3:[
  ['Python 中 sorted([3,1,2]) 的结果是？','[1, 2, 3]','[1, 2, 3]|[3, 2, 1]|None|报错'],
  ['Python 中 list.sort() 的返回值是？','None','None|排序后的列表|原列表的副本|布尔值'],
  ['Python 中 lambda x: x+1 表示什么？','匿名函数','匿名函数|循环|条件表达式|类'],
  ['Python 中递归函数必须有什么？','终止条件','终止条件|全局变量|返回值|装饰器'],
  ['Python 中 sum([1,2,3]) 的结果是？','6','6|5|123|报错'],
  ['Python 中 2**3 的结果是？','8','8|6|9|5'],
  ['Python 中 max([4,9,2]) 的结果是？','9','9|4|2|15']
 ],
 4:[
  ['Python 中 @decorator 这种写法的作用是？','装饰器，包装原函数','装饰器，包装原函数|声明变量|导入模块|定义子类'],
  ['Python 中含 yield 的函数返回的是？','生成器','生成器|列表|元组|None'],
  ['Python 中属于不可变类型的是？','tuple','tuple|list|dict|set'],
  ['Python 中在函数内修改全局变量需要先声明什么？','global','global|public|extern|var'],
  ['Python 中做深拷贝应使用哪个函数？','copy.deepcopy','copy.deepcopy|copy.copy|list()|dict()'],
  ['Python 中把 list 用作函数默认参数可能导致什么？','默认值在多次调用间共享','默认值在多次调用间共享|每次调用都重建|无法传参|运行时报错'],
  ['Python 中 GIL 限制了同一时刻只有几个线程执行字节码？','1 个','1 个|2 个|4 个|不受限制'],
  ['Python 中小整数与字符串的缓存机制主要影响什么？','is 比较的结果','is 比较的结果|== 比较的结果|内存回收速度|import 速度']
 ]
},
java:{
 0:[
  ['Java 程序入口方法的签名是？','public static void main(String[] args)','public static void main(String[] args)|public void main(String[] args)|static void Main()|public static main(String[] args)'],
  ['Java 中向控制台输出一行用哪个写法？','System.out.println','System.out.println|console.log|printf|echo'],
  ['Java 中定义类用哪个关键字？','class','class|struct|object|def'],
  ['Java 中基本的整型类型是？','int','int|integer|Int|long int'],
  ['Java 中字符串类型是？','String','String|string|str|char[]']
 ],
 1:[
  ['Java 中声明整型数组的正确写法是？','int[] a = new int[5];','int[] a = new int[5];|int a[5];|int a = new int[5];|array int a[5];'],
  ['Java 中 switch 不支持下列哪种类型？','double','double|int|char|String'],
  ['Java 中从方法返回结果用哪个关键字？','return','return|yield|give|out'],
  ['Java 中 else 后面继续判断分支写作？','else if','else if|elif|elseif|else when'],
  ['Java 中 for(int i=0;i<5;i++) 循环体执行几次？','5 次','5 次|4 次|6 次|0 次']
 ],
 2:[
  ['Java 中比较两个字符串内容是否相等应使用？','equals()','equals()|==|hashCode()|toString()'],
  ['Java 中 String 的 length() 返回什么？','字符个数','字符个数|字节数|内存占用|数组长度'],
  ['Java 中创建对象使用哪个关键字？','new','new|create|make|alloc'],
  ['Java 中 ArrayList 的特点是什么？','可变长度的列表','可变长度的列表|定长数组|键值对集合|线程安全队列'],
  ['Java 中 s.substring(1,3) 取的是？','下标 1 到 2 的字符','下标 1 到 2 的字符|下标 1 到 3 的字符|前 3 个字符|最后 3 个字符']
 ],
 3:[
  ['Java 中继承父类用哪个关键字？','extends','extends|implements|inherits|super'],
  ['Java 中实现接口用哪个关键字？','implements','implements|extends|interface|abstract'],
  ['Java 中捕获异常用哪组关键字？','try-catch','try-catch|try-except|do-catch|catch-finally'],
  ['Java 中重写父类方法通常加什么注解？','@Override','@Override|@Overload|@Rewrite|@Super'],
  ['Java 中父类引用指向子类对象体现了什么特性？','多态','多态|封装|继承|重载'],
  ['Java 中 final 修饰的类有什么特点？','不能被继承','不能被继承|不能被实例化|不能被引用|不能被编译']
 ],
 4:[
  ['Java 中泛型 List<String> 的作用是？','限定元素类型','限定元素类型|限定列表长度|提高运行速度|自动排序'],
  ['Java 中启动线程通常调用哪个方法？','start()','start()|run()|exec()|begin()'],
  ['Java 中垃圾回收主要回收什么？','不再被引用的对象占用的内存','不再被引用的对象占用的内存|磁盘文件|线程栈|类定义'],
  ['Java 中 static 成员属于？','类本身','类本身|每个对象|父类|接口'],
  ['Java 中接口里的方法默认修饰符是？','public abstract','public abstract|private|protected|static final']
 ]
},
js:{
 0:[
  ['JavaScript 中声明块级作用域变量用哪个关键字？','let','let|var|const|def'],
  ['JavaScript 中向控制台输出用哪个写法？','console.log','console.log|print|printf|System.out.println'],
  ['JavaScript 中 typeof 返回的是什么？','数据类型的字符串','数据类型的字符串|变量的值|内存地址|布尔值'],
  ['JavaScript 中严格相等运算符是？','===','===|==|=|!=='],
  ['JavaScript 中声明常量的关键字是？','const','const|let|var|final']
 ],
 1:[
  ['JavaScript 中向数组末尾添加元素用哪个方法？','push()','push()|pop()|shift()|unshift()'],
  ['JavaScript 中获取数组长度的属性是？','length','length|size|count|len'],
  ['JavaScript 中移除数组最后一个元素用哪个方法？','pop()','pop()|push()|shift()|slice()'],
  ['JavaScript 中模板字符串用哪对符号包裹？','反引号','反引号|单引号|双引号|圆括号'],
  ['JavaScript 中声明函数的传统关键字是？','function','function|func|def|fn']
 ],
 2:[
  ['JavaScript 中箭头函数的写法是？','() => {}','() => {}|function(){}|def(){}|fn(){}'],
  ['JavaScript 中数组的 map 方法返回什么？','一个新数组','一个新数组|原数组|单个元素|布尔值'],
  ['JavaScript 中 JSON.stringify 的作用是？','对象转 JSON 字符串','对象转 JSON 字符串|字符串转对象|深拷贝对象|格式化日期'],
  ['JavaScript 中 JSON.parse 的作用是？','JSON 字符串转对象','JSON 字符串转对象|对象转字符串|校验 JSON|压缩 JSON'],
  ['JavaScript 中 filter 方法返回什么？','满足条件的元素组成的新数组','满足条件的元素组成的新数组|第一个匹配元素|布尔值|原数组']
 ],
 3:[
  ['JavaScript 中 Promise 注册完成回调用哪个方法？','then','then|done|success|resolve'],
  ['JavaScript 中 await 只能用在哪种函数里？','async 函数','async 函数|普通函数|箭头函数|构造函数'],
  ['JavaScript 中闭包指的是什么？','函数与其引用的外部变量的组合','函数与其引用的外部变量的组合|立即执行函数|箭头函数|递归函数'],
  ['JavaScript 中按 id 获取元素用哪个方法？','document.getElementById','document.getElementById|document.querySelectorAll|document.getElementsByClassName|document.getElementsByTagName'],
  ['JavaScript 中 async 函数一定返回什么？','Promise','Promise|回调函数|生成器|布尔值']
 ],
 4:[
  ['JavaScript 中原型链的主要作用是？','实现对象间的属性继承','实现对象间的属性继承|管理内存|处理事件|解析 JSON'],
  ['JavaScript 中 setTimeout(fn,0) 的回调会在何时执行？','当前同步代码执行完后','当前同步代码执行完后|立即同步执行|下一帧绘制前|页面卸载时'],
  ['JavaScript 中普通函数的 this 取决于什么？','调用方式','调用方式|定义位置|函数名|参数个数'],
  ['JavaScript 中 let 与 var 的关键区别是？','let 具有块级作用域','let 具有块级作用域|let 不能重新赋值|var 不能声明函数|两者没有区别'],
  ['JavaScript 中 0.1 + 0.2 === 0.3 的结果是？','false','false|true|NaN|报错']
 ]
},
sql:{
 0:[
  ['SQL 中查询数据用哪个关键字？','SELECT','SELECT|GET|FIND|QUERY'],
  ['SQL 中指定查询的表用哪个关键字？','FROM','FROM|IN|TABLE|WHERE'],
  ['SQL 中筛选条件用哪个关键字？','WHERE','WHERE|IF|HAVING|WHEN'],
  ['SQL 中插入数据用哪组关键字？','INSERT INTO','INSERT INTO|ADD INTO|PUT INTO|APPEND TO'],
  ['SQL 语句结尾通常用哪个符号？','分号 ;','分号 ;|句号 .|冒号 :|斜杠 /']
 ],
 1:[
  ['SQL 中删除表中数据用哪个关键字？','DELETE','DELETE|REMOVE|DROP|CLEAR'],
  ['SQL 中修改数据用哪个关键字？','UPDATE','UPDATE|MODIFY|ALTER|SET'],
  ['SQL 中排序用哪组关键字？','ORDER BY','ORDER BY|SORT BY|GROUP BY|ARRANGE BY'],
  ['SQL 中限制返回行数用哪个关键字？','LIMIT','LIMIT|TOP|MAX|ROWS'],
  ['SQL 中模糊匹配用哪个关键字？','LIKE','LIKE|MATCH|REGEX|SIMILAR'],
  ['SQL 中降序排列用哪个关键字？','DESC','DESC|ASC|DOWN|REVERSE']
 ],
 2:[
  ['SQL 中连接两张表用哪个关键字？','JOIN','JOIN|LINK|MERGE|COMBINE'],
  ['SQL 中分组统计用哪组关键字？','GROUP BY','GROUP BY|ORDER BY|PARTITION BY|SPLIT BY'],
  ['SQL 中对分组结果筛选用哪个关键字？','HAVING','HAVING|WHERE|FILTER|ON'],
  ['SQL 中统计行数用哪个函数？','COUNT(*)','COUNT(*)|SUM(*)|TOTAL(*)|ROWS(*)'],
  ['SQL 中左连接的关键字是？','LEFT JOIN','LEFT JOIN|LEFT MERGE|JOIN LEFT|OUTER LEFT']
 ],
 3:[
  ['SQL 中子查询指的是什么？','嵌套在另一条语句中的查询','嵌套在另一条语句中的查询|并行执行的查询|被缓存的查询|一张视图'],
  ['数据库索引的主要作用是？','加快查询速度','加快查询速度|节省磁盘空间|保证事务完整|加密数据'],
  ['事务 ACID 中的 I 指什么？','隔离性','隔离性|完整性|独立性|幂等性'],
  ['SQL 中唯一约束的关键字是？','UNIQUE','UNIQUE|ONLY|DISTINCT|SINGLE'],
  ['SQL 中主键的特点是什么？','唯一且非空','唯一且非空|可以重复|可以为空|只能为数字']
 ],
 4:[
  ['SQL 中视图 VIEW 本质上是什么？','保存下来的查询','保存下来的查询|一张物理表|一个索引|一个触发器'],
  ['防止 SQL 注入最有效的做法是？','使用参数化查询','使用参数化查询|过滤单引号|隐藏表名|限制返回行数'],
  ['数据库第一范式要求什么？','每个字段不可再分','每个字段不可再分|必须有主键|不能有外键|必须有索引'],
  ['SQL 中存储过程的主要优点是什么？','预编译并可重复调用','预编译并可重复调用|自动创建索引|自动备份数据|自动加密字段'],
  ['SQL 中 TRUNCATE 与 DELETE 的主要区别是？','TRUNCATE 不能带条件且更快','TRUNCATE 不能带条件且更快|TRUNCATE 可以回滚|DELETE 会删除表结构|两者没有区别']
 ]
},
web:{
 0:[
  ['HTML 的全称是？','超文本标记语言','超文本标记语言|高级文本语言|超链接语言|网页编程语言'],
  ['HTML 中最大的标题标签是？','h1','h1|h6|title|head'],
  ['HTML 中定义段落的标签是？','p','p|div|span|br'],
  ['HTML 中定义超链接的标签是？','a','a|link|href|url'],
  ['HTML 中图片地址写在哪个属性里？','src','src|href|alt|url'],
  ['HTML 中定义无序列表的标签是？','ul','ul|ol|li|dl']
 ],
 1:[
  ['CSS 中选择 class 为 box 的元素用哪个写法？','.box','.box|#box|box|*box'],
  ['CSS 中选择 id 为 box 的元素用哪个写法？','#box','#box|.box|box|@box'],
  ['CSS 中设置文字颜色的属性是？','color','color|font-color|text-color|foreground'],
  ['CSS 中设置元素显示方式的属性是？','display','display|show|visible|layout'],
  ['CSS 中设置外边距的属性是？','margin','margin|padding|border|gap'],
  ['CSS 中设置内边距的属性是？','padding','padding|margin|border|spacing']
 ],
 2:[
  ['CSS 中开启弹性布局用哪个声明？','display:flex','display:flex|display:grid|position:flex|layout:flex'],
  ['CSS 中开启网格布局用哪个声明？','display:grid','display:grid|display:flex|display:table|display:block'],
  ['CSS 中让元素相对定位并保留原占位用？','position:relative','position:relative|position:absolute|position:fixed|position:static'],
  ['CSS 中让元素固定在视口用？','position:fixed','position:fixed|position:absolute|position:relative|position:sticky'],
  ['CSS 中媒体查询用哪个规则？','@media','@media|@query|@screen|@responsive'],
  ['CSS 中 flex 布局的主轴对齐用哪个属性？','justify-content','justify-content|align-items|flex-wrap|flex-direction']
 ],
 3:[
  ['CSS 盒模型由内到外依次是？','content → padding → border → margin','content → padding → border → margin|content → border → padding → margin|margin → padding → border → content|padding → content → border → margin'],
  ['CSS 中鼠标悬停的伪类是？',':hover',':hover|:focus|:active|:visited'],
  ['下列 CSS 选择器中优先级最高的是？','行内样式','行内样式|类选择器|标签选择器|后代选择器'],
  ['响应式页面通常需要在 head 里加什么？','viewport meta','viewport meta|charset meta|base 标签|link 标签'],
  ['CSS 中 box-sizing:border-box 的作用是？','宽高包含 padding 和 border','宽高包含 padding 和 border|宽高只包含内容|去掉边框|禁用盒模型'],
  ['CSS 中 :nth-child(2) 表示什么？','父元素下的第 2 个子元素','父元素下的第 2 个子元素|第 2 个 class 元素|第 2 个兄弟中的任意元素|最后一个子元素']
 ],
 4:[
  ['CSS 中定义关键帧动画用哪个规则？','@keyframes','@keyframes|@animation|@transition|@frames'],
  ['CSS 变量的声明方式是？','--name: value','--name: value|$name: value|@name: value|var name: value'],
  ['浏览器渲染流程的正确顺序是？','解析 → 布局 → 绘制 → 合成','解析 → 布局 → 绘制 → 合成|布局 → 解析 → 合成 → 绘制|解析 → 绘制 → 布局 → 合成|绘制 → 布局 → 解析 → 合成'],
  ['图片懒加载的主要目的是什么？','减少首屏请求与流量','减少首屏请求与流量|提升图片清晰度|加快服务器编译|避免浏览器缓存'],
  ['防抖（debounce）的作用是什么？','频繁触发时只执行最后一次','频繁触发时只执行最后一次|立即执行第一次|按固定间隔执行|并行执行所有调用']
 ]
}
};

/* ---------- 参数化生成器（每题答案当场计算，解析与答案同源） ---------- */
function binExp(n){var s=binOf(n),p=[];for(var i=0;i<s.length;i++){if(s.charAt(i)==='1')p.push(String(Math.pow(2,s.length-1-i)));}return '按位权展开：'+s+'₂ = '+p.join(' + ')+' = '+n;}
function bitExp(a,b,ans,op){
  var name={and:'按位与',or:'按位或',xor:'按位异或'}[op];
  var rule={and:'同为 1 才得 1',or:'有一位是 1 就得 1',xor:'两位不同才得 1'}[op];
  return name+'：'+rule+'，'+binOf(a)+' '+({and:'&',or:'|',xor:'^'}[op])+' '+binOf(b)+' = '+binOf(ans)+' = '+ans;
}
function factSeq(n){var a=[];for(var i=1;i<=n;i++)a.push(i);return a.join(' × ');}
var CODE_GENX={
all:{
 0:[
  function(){var n=riN(5,63);return mkQA('二进制 '+binOf(n)+' 等于十进制多少？',n,neighbors(n),binExp(n));},
  function(){var n=riN(5,63),s=binOf(n);return mkQA('十进制 '+n+' 的二进制是？',s,binWrongs(s),'用 2 不断除取余、余数倒序排列：'+n+' = '+s+'₂');},
  function(){var n=riN(16,255);return mkQA('十六进制 0x'+hexOf(n)+' 等于十进制多少？',n,neighbors(n),'按 16 的幂展开：0x'+hexOf(n)+' 每位乘 16⁰、16¹… 累加得 '+n);},
  function(){var n=riN(16,255);return mkQA('十进制 '+n+' 的十六进制是？',hexOf(n),[hexOf(n^1),hexOf(n^2),hexOf(n^4)],'用 16 不断除取余、余数倒序排列：'+n+' = 0x'+hexOf(n));},
  function(){var i=riN(0,25),ch=String.fromCharCode(65+i);return mkQA('大写字母 '+ch+' 的 ASCII 码是？',65+i,neighbors(65+i),'A 从 65 起按字母表递增，'+ch+' 是第 '+(i+1)+' 个：65 + '+i+' = '+(65+i));}
 ],
 1:[
  function(){var a=riN(20,99),b=riN(3,9);return mkQA(a+' % '+b+'（取余）的结果是？',a%b,neighbors(a%b),a+' ÷ '+b+' = '+Math.floor(a/b)+' 余 '+(a%b)+'，取余只看余数');},
  function(){var a=riN(2,9),b=riN(2,9),c=riN(2,9);return mkQA('表达式 '+a+' + '+b+' × '+c+' 的值是？',a+b*c,[(a+b)*c,a*b+c,a+b+c].concat(neighbors(a+b*c)),'先乘除后加减：'+b+' × '+c+' = '+(b*c)+'，再加 '+a+' 得 '+(a+b*c));},
  function(){var a=riN(11,99),b=riN(2,9);return mkQA('整数除法 '+a+' / '+b+'（向下取整）的结果是？',Math.floor(a/b),neighbors(Math.floor(a/b)),b+' × '+Math.floor(a/b)+' = '+(b*Math.floor(a/b))+'，整数除法把余数丢掉，得 '+Math.floor(a/b));}
 ],
 2:[
  function(){var a=riN(1,15),b=riN(1,15);return mkQA(a+' & '+b+'（按位与）的结果是？',a&b,bitCands(a,b,a&b),bitExp(a,b,a&b,'and'));},
  function(){var a=riN(1,15),b=riN(1,15);return mkQA(a+' | '+b+'（按位或）的结果是？',a|b,bitCands(a,b,a|b),bitExp(a,b,a|b,'or'));},
  function(){var a=riN(1,15),b=riN(1,15);return mkQA(a+' ^ '+b+'（按位异或）的结果是？',a^b,bitCands(a,b,a^b),bitExp(a,b,a^b,'xor'));},
  function(){var a=riN(1,9),k=riN(1,3);return mkQA(a+' << '+k+'（左移）的结果是？',a<<k,shiftCands(a,k,a<<k),'左移 '+k+' 位等于乘 '+Math.pow(2,k)+'：'+a+' × '+Math.pow(2,k)+' = '+(a<<k));}
 ],
 3:[],
 4:[
  function(){var v=riN(1,63);return mkQA('8 位补码中，-'+v+' 的二进制表示是？',binOf(256-v,8),[binOf(v,8),binOf(v|128,8),binOf(255-v,8)],'补码 = 256 − '+v+' = '+(256-v)+'，写成 8 位二进制就是 '+binOf(256-v,8));}
 ]
},
c:{
 0:[],
 1:[
  function(){var a=riN(2,9),b=riN(2,9),c=riN(2,9);return mkQA('C 语言中，表达式 '+a+' + '+b+' * '+c+' 的值是？',a+b*c,[(a+b)*c,a*b+c,a+b+c].concat(neighbors(a+b*c)),'C 里 * 优先级高于 +：先算 '+b+' * '+c+' = '+(b*c)+'，再加 '+a+' 得 '+(a+b*c));},
  function(){var x=riN(1,9);return mkQA('C 语言中 int x='+x+'; 执行 printf("%d", x++); 输出的是？',x,neighbors(x),'x++ 是后置自增：先取用旧值 '+x+' 打印，之后 x 才变成 '+(x+1));},
  function(){var n=riN(2,12);return mkQA('C 语言中 for(int i=0;i<'+n+';i++) 的循环体执行几次？',n,neighbors(n),'i 从 0 开始、取到 '+(n-1)+' 为止，一共 '+n+' 次');},
  function(){var n=riN(3,10);return mkQA('C 语言中 int a['+n+']; 最后一个元素的下标是？',n-1,neighbors(n-1),'C 数组下标从 0 开始，'+n+' 个元素的下标是 0 ~ '+(n-1));},
  function(){var a=riN(1,9),b=riN(1,9);return mkQA('C 语言中 (a>b)?a:b，当 a='+a+'、b='+b+' 时结果是？',Math.max(a,b),neighbors(Math.max(a,b)),'三目运算符先判条件：'+(a>b?'a>b 成立，取 a = ':'a>b 不成立，取 b = ')+Math.max(a,b));}
 ],
 2:[
  function(){var T=[['char',1],['short',2],['int',4],['float',4],['double',8]],it=T[ri(T.length)];return mkQA('C 语言中，在常见 64 位平台上 sizeof('+it[0]+') 的值通常是？',it[1],neighbors(it[1]),'在 64 位平台上 '+it[0]+' 占 '+it[1]+' 个字节');},
  function(){var a=riN(1,15),b=riN(1,15);return mkQA('C 语言中，'+a+' & '+b+' 的结果是？',a&b,bitCands(a,b,a&b),bitExp(a,b,a&b,'and'));},
  function(){var a=riN(1,20),k=riN(1,3);return mkQA('C 语言中，'+a+' << '+k+' 的结果是？',a<<k,shiftCands(a,k,a<<k),'左移 '+k+' 位等于乘 '+Math.pow(2,k)+'：'+a+' × '+Math.pow(2,k)+' = '+(a<<k));}
 ],
 3:[
  function(){var n=riN(3,6);return mkQA('C 语言中，递归计算 '+n+'! 的结果是？',fact(n),neighbors(fact(n)),'阶乘连乘：'+n+'! = '+factSeq(n)+' = '+fact(n));},
  function(){var n=riN(5,9);return mkQA('斐波那契数列 F(1)=1、F(2)=1，则 F('+n+') 的值是？',fibOf(n),neighbors(fibOf(n)),'按 F(n)=F(n−1)+F(n−2) 逐项递推，F('+n+') = '+fibOf(n));}
 ],
 4:[
  function(){var v=riN(128,255);return mkQA('在常见补码平台上，8 位有符号 char 存储 '+v+' 会得到？',v-256,neighbors(v-256),'8 位有符号 char 上限 127，'+v+' 越界后按补码回绕：'+v+' − 256 = '+(v-256));}
 ]
},
python:{
 0:[],
 1:[
  function(){var W=['code','python','list','hello','data','test','java','web'],s=W[ri(W.length)];return mkQA('Python 中 len("'+s+'") 的结果是？',s.length,neighbors(s.length),'len() 数字符个数，"'+s+'" 一共 '+s.length+' 个字符');},
  function(){var n=riN(3,10);return mkQA('Python 中 sum(range('+n+')) 的结果是？',n*(n-1)/2,neighbors(n*(n-1)/2),'range('+n+') 是 0 ~ '+(n-1)+'，首尾相加乘项数除以 2，得 '+(n*(n-1)/2));},
  function(){var s='abcdefgh',i=riN(0,3),j=riN(i+2,7),ans=s.slice(i,j);return mkQA('Python 中 "'+s+'"['+i+':'+j+'] 的结果是？',ans,[s.slice(i,j+1),s.slice(i+1,j),s.slice(i+1,j+1),ans.toUpperCase()],'切片含头不含尾，取下标 '+i+' 到 '+(j-1)+'，得 "'+ans+'"');}
 ],
 2:[
  function(){var n=riN(10,99);return mkQA('Python 中 d={"a": '+n+'}，则 d["a"] 的值是？',n,neighbors(n),'字典按键取值，d["a"] 就是构造时写进去的 '+n);}
 ],
 3:[
  function(){var n=riN(3,9);return mkQA('Python 中 max(list(range('+n+'))) 的结果是？',n-1,neighbors(n-1),'range('+n+') 是 0 ~ '+(n-1)+'，最大值是 '+(n-1));}
 ],
 4:[]
},
java:{
 0:[],
 1:[
  function(){var n=riN(2,12);return mkQA('Java 中 for(int i=0;i<'+n+';i++) 的循环体执行几次？',n,neighbors(n),'i 从 0 走到 '+(n-1)+'，共 '+n+' 次');},
  function(){var n=riN(2,9);return mkQA('Java 中 int[] a = new int['+n+']; 该数组的 length 是？',n,neighbors(n),'new int['+n+'] 申请 '+n+' 个元素，length 就是 '+n);}
 ],
 2:[
  function(){var W=['hello','java','code','world','array'],s=W[ri(W.length)];return mkQA('Java 中 "'+s+'".length() 的结果是？',s.length,neighbors(s.length),'length() 数字符个数，"'+s+'" 有 '+s.length+' 个字符');},
  function(){var s='abcdef',i=riN(0,3);return mkQA('Java 中 "'+s+'".substring('+i+') 的结果是？',s.slice(i),[s.slice(i+1),s.slice(Math.max(0,i-1)),s.slice(0,i+1),s.slice(i,i+2)],'substring(n) 从下标 n 取到末尾，结果是 "'+s.slice(i)+'"');}
 ],
 3:[],
 4:[]
},
js:{
 0:[],
 1:[
  function(){var n=riN(2,9),arr=[];for(var i=0;i<n;i++)arr.push(i+1);return mkQA('JavaScript 中 ['+arr.join(',')+'].length 的值是？',n,neighbors(n),'length 是元素个数，数组里有 '+n+' 个元素');},
  function(){var n=riN(1,5),x=riN(1,9),arr=[];for(var i=0;i<n;i++)arr.push(i+1);return mkQA('JavaScript 中 var a=['+arr.join(',')+']; a.push('+x+'); 之后 a.length 的值是？',n+1,neighbors(n+1),'push 在末尾追加一个元素：'+n+' + 1 = '+(n+1));}
 ],
 2:[
  function(){var n=riN(2,4),k=riN(2,3),arr=[];for(var i=0;i<n;i++)arr.push(riN(1,5));var out=arr.map(function(x){return x*k});return mkQA('JavaScript 中 ['+arr.join(',')+'].map(x => x * '+k+') 的结果是？','['+out.join(', ')+']',['['+arr.join(', ')+']','['+out.map(function(x){return x+1}).join(', ')+']','['+out.concat([out[0]]).join(', ')+']','['+arr.map(function(x){return x+k}).join(', ')+']'],'map 逐个元素乘以 '+k+'：'+arr.join("、")+' 分别变成 '+out.join("、"));}
 ],
 3:[],
 4:[]
},
sql:{
 0:[],
 1:[
  function(){var n=riN(5,100);return mkQA('SQL 中 SELECT * FROM t LIMIT '+n+' 最多返回多少行？',n,neighbors(n),'LIMIT '+n+' 限制结果集最多 '+n+' 行');}
 ],
 2:[],
 3:[],
 4:[]
},
web:{
 0:[],
 1:[],
 2:[
  function(){var w=riN(50,300),p=riN(5,20);return mkQA('CSS 中 width:'+w+'px; padding:'+p+'px;（box-sizing 为默认 content-box）该元素实际占宽多少 px？',w+p*2,neighbors(w+p*2),'content-box 下 width 只是内容宽，左右各加 '+p+' 的内边距：'+w+' + '+p+'×2 = '+(w+p*2));},
  function(){var w=riN(50,300),p=riN(5,20);return mkQA('CSS 中 width:'+w+'px; padding:'+p+'px; 且 box-sizing:border-box，内容区宽度是多少 px？',w-p*2,neighbors(w-p*2),'border-box 下 width 含内边距，内容宽 = '+w+' − '+p+'×2 = '+(w-p*2));}
 ],
 3:[],
 4:[]
}
};
/* ---------- 知识点池生成器 ---------- */
function kbGen(list){
  var g=function(){
    var it=list[ri(list.length)];
    return mkQA(it[0],it[1],String(it[2]||'').split('|'));
  };
  g.kb=list.length;
  return g;
}
function tagGen(g,L){
  var w=function(){
    var q=g();
    if(q&&!q.tag)q.tag=L;
    return q;
  };
  w.kb=g.kb;w.lang=L;
  return w;
}

var CODE_LANG_KEYS=['c','python','java','js','sql','web','all'];
/* P1-4：CODE_GENX 每个生成器的参数空间（kb = 随机变量取值数之积，固定题记 1）。
   由 tagGen 抄到 CODE_GEN 的包装函数上，codeEstimate 才能按真实参数空间统计（旧版一律按 600 估）。 */
var CODE_GENX_KB={
 all:{0:[59,59,240,240,26],1:[560,512,712],2:[225,225,225,27],4:[63]},
 c:{1:[512,9,11,8,81],2:[5,225,60],3:[4,5],4:[128]},
 python:{1:[8,8,18],2:[90],3:[7]},
 java:{1:[11,8],2:[5,4]},
 js:{1:[8,45],2:[30]},
 sql:{1:[96]},
 web:{2:[4016,4016]}
};
(function(){for(var L in CODE_GENX_KB){if(!CODE_GENX_KB.hasOwnProperty(L))continue;
  for(var d in CODE_GENX_KB[L]){if(!CODE_GENX_KB[L].hasOwnProperty(d))continue;
    var ks=CODE_GENX_KB[L][d],fs=(CODE_GENX[L]||{})[d]||[];
    for(var i=0;i<fs.length&&i<ks.length;i++){if(fs[i]&&ks[i]!=null)fs[i].kb=ks[i];}
  }}})();

var CODE_GEN={};
(function(){
  CODE_LANG_KEYS.forEach(function(L){
    CODE_GEN[L]={};
    for(var d=0;d<5;d++){
      var arr=[],ks=(CODE_KB[L]||{})[String(d)]||[];
      if(ks.length)arr.push(tagGen(kbGen(ks),L));
      var xs=(CODE_GENX[L]||{})[String(d)]||[];
      for(var i=0;i<xs.length;i++)arr.push(tagGen(xs[i],L));
      CODE_GEN[L][String(d)]=arr;
    }
  });
})();
/* 题量估算口径（P1-4）：人工题按实际条数、模板生成器按自己的参数空间（kb）累加。
   旧版对没有 kb 的生成器一律按 600 估，书架会显示「≥X 万题」，实际参数空间远小于此。 */
function codeEstimate(){
  var manual=0,gen=0,k,L;
  for(k in POOLS.code)if(POOLS.code.hasOwnProperty(k))manual+=POOLS.code[k].length;
  for(L in CODE_GEN)if(CODE_GEN.hasOwnProperty(L)){
    for(k in CODE_GEN[L])if(CODE_GEN[L].hasOwnProperty(k)){
      CODE_GEN[L][k].forEach(function(g){gen+=(g&&g.kb)?g.kb:60;});
    }
  }
  return manual+gen;
}
/* 分项给人看：[人工题, 模板题] */
function codeEstimateParts(){
  var n=codeEstimate(),manual=0,k;
  for(k in POOLS.code)if(POOLS.code.hasOwnProperty(k))manual+=POOLS.code[k].length;
  return {manual:manual,gen:Math.max(0,n-manual),total:n};
}
/* 语言档案三态：
   'unset'  = 从没做过检测（或数据损坏）→ 出全部语言，但 UI 必须显式警示
   'all'    = 用户明确「跳过 / 全部语言」→ 出全部语言，不警示
   'only'   = 用户显式勾选了语言 → 严格只出这些 + all
   旧数据兼容：done=true 且 langs=[] 且没有 all 字段 → 视为 'unset'（疑似「跳过」旧写法） */
function codeLangState(){
  var p=null;
  try{p=JSON.parse(S.getItem(CODE_PROFILE_KEY)||'null');}catch(e){p=null;}
  if(!p||!p.done)return {mode:'unset',langs:[]};
  if(p.all)return {mode:'all',langs:[]};
  if(p.langs&&p.langs.length)return {mode:'only',langs:p.langs.slice()};
  return {mode:'unset',langs:[]};
}
/* 语言过滤：读过实力检测档案就只出勾选语言 + 通用题 */
function codeAllowedLangs(){
  var st=codeLangState();
  if(st.mode==='only')return st.langs.concat(['all']);
  return null;                     /* unset / all → 不过滤 */
}
/* 最终语言闸：档案为 only 时，凡 tag 不在允许列表且不是 all 的题一律丢弃。
   放在所有取题出口的最后一步，防止任何补池/兜底/回顾路径把别的语言带进来。 */
function langGuard(qs){
  var allowed=codeAllowedLangs();
  if(!allowed)return qs||[];
  return (qs||[]).filter(function(q){
    if(!q)return false;
    var t=String(q.tag||'all');
    return t==='all'||allowed.indexOf(t)>=0;
  });
}
/* 出题：人工题限量（保证不把生成器饿死）+ 近期去重（跨局不撞题）+ 生成器补齐 */
function codeLoadRecent(k){
  try{var a=JSON.parse(S.getItem(k)||'[]');return Array.isArray(a)?a:[];}catch(e){return [];}
}
function codeSaveRecent(k,a){
  try{S.setItem(k,JSON.stringify(a.slice(0,80)));}catch(e){}
}
QA_TYPES.code.gen=function(n,diff){
  n=Math.max(1,n|0);
  var dd=(typeof diff==='number'&&diff>=0&&diff<5)?diff:0;
  var pool=POOLS.code[String(dd)]||POOLS.code['0']||[];
  var allowed=codeAllowedLangs();
  var filtered=[];
  pool.forEach(function(it){
    if(allowed&&allowed.indexOf(it[2]||'all')<0)return;
    filtered.push(it);
  });
  var rk='bt_qa_recent_code_'+dd;
  var rec=codeLoadRecent(rk),recSet={};
  rec.forEach(function(x){if(x)recSet[x]=1;});
  var seen={};
  if(n===1&&typeof qlist!=='undefined'&&qlist&&qlist.length){
    qlist.forEach(function(x){if(x&&x.q)seen[x.q]=1;});
  }
  var langs=allowed||CODE_LANG_KEYS;
  var gens=[];
  langs.forEach(function(L){
    var g=(CODE_GEN[L]||{})[String(dd)]||[];
    g.forEach(function(x){gens.push(x);});
  });
  /* 人工题每局最多占一半，且保证连刷 5 局不重复（按人工题总数反推本局上限） */
  var cap=Math.max(1,Math.min(Math.round(n*0.5),Math.floor(filtered.length/5)));
  if(n>=4&&cap<2)cap=2;
  var out=[];
  var order=filtered.slice().sort(function(a,b){
    var ra=recSet[a[0]]?1:0,rb=recSet[b[0]]?1:0;
    if(ra!==rb)return ra-rb;
    return Math.random()-0.5;
  });
  order.forEach(function(it){
    if(out.length>=cap)return;
    if(seen[it[0]])return;
    var q=mkFromPool(it,filtered);
    if(!q||seen[q.q])return;
    q.tag=it[2]||'all';
    seen[q.q]=1;out.push(q);
  });
  var guard=0,relaxed=false;
  while(out.length<n&&gens.length&&guard++<900){
    if(guard>380)relaxed=true;
    var g=gens[riN(0,gens.length-1)],q=null;
    try{q=g();}catch(e){continue;}
    if(!q||!q.q||q.a==null)continue;
    if(q.tag&&allowed&&allowed.indexOf(q.tag)<0)continue;
    if(seen[q.q])continue;
    if(!relaxed&&recSet[q.q])continue;
    seen[q.q]=1;out.push(q);
  }
  /* 单语言档位题量不够时，用 all 的相邻档补齐（规格允许，避免无题可出） */
  if(out.length<n){
    var alt=[dd,dd-1,dd+1,dd-2,dd+2];
    for(var ai=0;ai<alt.length&&out.length<n;ai++){
      var ad=alt[ai];
      if(ad<0||ad>4)continue;
      var ag=(CODE_GEN.all||{})[String(ad)]||[];
      if(!ag.length)continue;
      guard=0;
      while(out.length<n&&guard++<300){
        var aq=null;
        try{aq=ag[riN(0,ag.length-1)]();}catch(e){continue;}
        if(!aq||!aq.q||aq.a==null||seen[aq.q])continue;
        aq.tag='all';seen[aq.q]=1;out.push(aq);
      }
    }
  }
  out=out.slice(0,n);
  codeSaveRecent(rk,out.map(function(x){return x.q;}).concat(rec));
  return out;
};
/* ===== 程序编写板块：读代码 / 补全代码（答案当场算出，绝不写死） ===== */
function mkCodeQ(prompt,code,ans,alts,exp){
  /* 选项去重后再按数值补足到 4 个，避免参数巧合时只剩 3 个选项 */
  var a=String(ans),seen={},list=[];seen[a]=1;
  (alts||[]).forEach(function(x){x=String(x);if(seen[x]||list.length>=3)return;seen[x]=1;list.push(x);});
  /* 补足条件放宽到「任意纯数字串」：整数按 ±1/±2 偏移，小数保持原有小数位，
     否则像 "4.0" 这种答案（Number→4→"4" 与原串不等）会被判成不可补位，只剩 3 个选项 */
  var num=/^-?\d+(\.\d+)?$/.test(a)?Number(a):NaN;
  if(list.length<3&&isFinite(num)){
    var dec=a.indexOf('.')>=0?a.split('.')[1].length:0,k=1;
    while(list.length<3&&k<200){
      var d=Math.ceil(k/2)*(k%2?1:-1),w=(num+d).toFixed(dec);
      if(!seen[w]){seen[w]=1;list.push(w);}
      k++;
    }
  }
  var q=mkQA(prompt,a,list,exp);
  q.code=code;q.kind='out';
  return q;
}
function mkCodeFill(prompt,code,ans,cands,exp){
  var q=mkQA(prompt,ans,cands||[],exp);
  q.code=code;q.opts=null;q.fillin=1;q.kind='fill';
  return q;
}
/* ===== 程序编写 · 知识点×难度矩阵（替代 CODE_GEN_CODE 的分档数组） =====
   每个 topic：{k:知识点, lang:语言, ranks:[可出题的档位], gen:生成函数}
   组题时按当前档位过滤 → 随机抽知识点 → 调 gen() 生成一题（答案当场算出）。
   低档 = 数制码制/数据类型/运算符/顺序/选择（用户点名的 C 基础）
   中档 = 循环/数组/字符串   高档 = 函数/指针/递归/算法    */
var CODE_TOPICS=[
  /* ---- rank 0 · 数制与码制（C 基础第一章） ---- */
  {k:'十进制转二进制',lang:'c',ranks:[0],kb:11,gen:function(){
    var n=riN(5,15),b=n.toString(2);
    return mkCodeQ('把十进制 '+n+' 转成二进制，结果是？',
      '// 手算或除 2 取余',b,
      [bitsFlip(b),bitsFlip2(b),String(n+1)],
      n+' 转二进制：'+n+' = '+b.split('').join('+')+'₂（除 2 取余倒序排列）');
  }},
  {k:'二进制转十进制',lang:'c',ranks:[0],kb:16,gen:function(){
    var b=randBits(4),d=parseInt(b,2);
    return mkCodeQ('二进制 '+b+'₂ 对应的十进制是？',
      '// 按位权展开',String(d),
      [String(d+1),String(d+2),String(d-1)],
      b+'₂ = 按权展开：'+b.split('').map(function(ch,i){return ch+'×2^'+(3-i);}).join(' + ')+' = '+d);
  }},
  {k:'十六进制转十进制',lang:'c',ranks:[0],kb:14,gen:function(){
    var n=riN(2,15),h=n.toString(16).toUpperCase();
    return mkCodeQ('十六进制 0x'+h+' 对应的十进制是？',
      '// 0x 前缀表示十六进制',String(n),
      [String(n+1),String(n+2),String(n*2)],
      '0x'+h+' = '+n+'（十六进制位权是 16，A=10…F=15）');
  }},
  {k:'十进制转十六进制',lang:'c',ranks:[0],kb:21,gen:function(){
    var n=riN(10,30),h=n.toString(16).toUpperCase();
    return mkCodeQ('十进制 '+n+' 转成十六进制，结果是？',
      '// 除 16 取余',h,
      pickAlts(h,['0x'+h,String(n+1),String(n+2),String(n*2)]),
      n+' 转十六进制 = 0x'+h+'（除 16 取余倒序）');
  }},
  {k:'原码补码概念',lang:'c',ranks:[0],kb:5,gen:function(){
    var n=riN(3,7);
    return mkCodeQ('int 类型里，负数通常用什么码存储？',
      '// C 语言整型负数存储方式','补码',
      ['原码','反码','ASCII码'],
      'C 里 int 负数用补码存储：符号位不变、其余取反再加 1（例：-'+n+' 的补码由 '+n+' 的二进制取反+1 得到）');
  }},
  /* ---- rank 0 · 基本数据类型 ---- */
  {k:'sizeof 类型大小',lang:'c',ranks:[0],kb:4,gen:function(){
    var ts=[['char',1],['int',4],['float',4],['double',8]],t=ts[riN(0,3)];
    return mkCodeQ('在 32 位体系下，sizeof('+t[0]+') 的值是？',
      'printf("%d", sizeof('+t[0]+'));',String(t[1]),
      [String(t[1]+1),String(t[1]+4),String(t[1]*2)],
      'sizeof('+t[0]+') 返回该类型占的字节数：'+t[0]+' 占 '+t[1]+' 字节（int 按 4 字节计）');
  }},
  {k:'整数除法',lang:'c',ranks:[0],kb:10,gen:function(){
    var a=riN(5,9),b=riN(2,3);
    return mkCodeQ('这段 C 代码输出什么？',
      'int a = '+a+', b = '+b+';\nprintf("%d", a / b);',
      String(Math.floor(a/b)),[String(a/b),String(Math.ceil(a/b)),String(a-b)],
      '两个 int 相除结果是整数（向零取整）：'+a+'÷'+b+' = '+(a/b)+'，取整得 '+Math.floor(a/b));
  }},
  {k:'ASCII 与字符',lang:'c',ranks:[0],kb:4,gen:function(){
    var c=['A','B','C','D'][riN(0,3)],d=c.charCodeAt(0);
    return mkCodeQ('这段 C 代码输出什么？',
      'char c = \''+c+'\';\nprintf("%d", c);',
      String(d),[String(d+1),String(d-1),String(d+32)],
      '字符 \''+c+'\' 的 ASCII 码是 '+d+'，%d 按整数输出');
  }},
  {k:'类型隐式转换',lang:'c',ranks:[0],kb:1,gen:function(){
    return mkCodeQ('这段 C 代码输出什么？',
      'printf("%f", 7.0 / 2);',
      '3.500000',['3','3.5','4'],
      '7.0 是浮点数，7.0/2 结果是浮点 3.5，%f 默认保留 6 位小数输出 3.500000');
  }},
  /* ---- rank 0-1 · 运算符与表达式 ---- */
  {k:'后置自增',lang:'c',ranks:[0,1],kb:7,gen:function(){
    var a=riN(2,8);
    return mkCodeQ('这段 C 代码输出什么？',
      'int a = '+a+';\nint b = a++;\nprintf("%d", b);',
      String(a),[String(a+1),String(a+2),String(a-1)],
      'a++ 是先取 a 的值赋给 b、再让 a 自增，所以 b = '+a+'（a 变成 '+(a+1)+'）');
  }},
  {k:'前置自增',lang:'c',ranks:[0,1],kb:7,gen:function(){
    var a=riN(2,8);
    return mkCodeQ('这段 C 代码输出什么？',
      'int a = '+a+';\nint b = ++a;\nprintf("%d", b);',
      String(a+1),[String(a),String(a+2),String(a-1)],
      '++a 是先把 a 自增再赋值，所以 b = '+(a+1));
  }},
  {k:'取余运算',lang:'c',ranks:[0,1],kb:52,gen:function(){
    var a=riN(7,19),b=riN(3,6);
    return mkCodeQ('这段 C 代码输出什么？',
      'int a = '+a+', b = '+b+';\nprintf("%d", a % b);',
      String(a%b),[String(b),String(Math.floor(a/b)),String(a%b+b)],
      'a % b 是取余数：'+a+' ÷ '+b+' 商 '+Math.floor(a/b)+' 余 '+(a%b));
  }},
  {k:'变量相加输出',lang:'c',ranks:[0],kb:64,gen:function(){
    var a=riN(2,9),b=riN(2,9);
    return mkCodeQ('这段 C 代码输出什么？',
      'int x = '+a+';\nint y = '+b+';\nprintf("%d", x + y);',
      String(a+b),[String(a*b),String(a-b),String(a+b+1)],
      'x='+a+'、y='+b+'，printf 里算 x + y，输出 '+(a+b));
  }},
  /* ---- rank 0 · 顺序结构 / printf 格式 ---- */
  {k:'printf 格式符',lang:'c',ranks:[0],kb:8,gen:function(){
    var v=riN(2,9);
    return mkCodeQ('这段 C 代码输出什么？',
      'printf("%d", '+v+');',
      String(v),[String(v+1),String(v*2),String(v+10)],
      '%d 按十进制整数输出，直接打印 '+v);
  }},
  {k:'printf 连续输出',lang:'c',ranks:[0],kb:25,gen:function(){
    var a=riN(1,5),b=riN(1,5);
    return mkCodeQ('这段 C 代码输出什么？',
      'printf("%d%d", '+a+', '+b+');',
      String(a)+String(b),pickAlts(String(a)+String(b),[String(a+b),String(b)+String(a),String(a)+String(b+1),String(a+1)+String(b)]),
      '%d%d 是两个占位符、中间没有分隔符，所以两个数直接拼在一起：'+a+b);
  }},
  /* ---- rank 1 · 运算符与表达式 ---- */
  {k:'运算优先级',lang:'c',ranks:[1],kb:27,gen:function(){
    var a=riN(2,4),b=riN(2,4),c=riN(2,4);
    return mkCodeQ('这段 C 代码输出什么？',
      'printf("%d", '+a+' + '+b+' * '+c+');',
      String(a+b*c),[String((a+b)*c),String(a+b+c),String(a*b+c)],
      '乘除优先于加减：'+a+' + '+b+' × '+c+' = '+(b*c)+'，再加 '+a+' = '+(a+b*c));
  }},
  {k:'复合赋值',lang:'c',ranks:[1],kb:20,gen:function(){
    var a=riN(3,7),b=riN(2,5);
    return mkCodeQ('这段 C 代码输出什么？',
      'int x = '+a+';\nx += '+b+';\nprintf("%d", x);',
      String(a+b),[String(a-b),String(a*b),String(a+b+1)],
      'x += '+b+' 等价于 x = x + '+b+'，所以 x = '+(a+b));
  }},
  {k:'三目运算',lang:'c',ranks:[1],kb:7,gen:function(){
    var a=riN(3,9),b=a>=5?'A':'B';
    return mkCodeQ('这段 C 代码输出什么？',
      'int x = '+a+';\nprintf("%c", x >= 5 ? \'A\' : \'B\');',
      b,[b==='A'?'B':'A','C','5'],
      '三目运算：x>=5 成立输出 A，不成立输出 B；x='+a+'，所以输出 '+b);
  }},
  {k:'位运算',lang:'c',ranks:[1,2],kb:147,gen:function(){
    var a=riN(1,7),b=riN(1,7),op=['&','|','^'][riN(0,2)];
    var r=op==='&'?(a&b):op==='|'?(a|b):(a^b);
    return mkCodeQ('这段 C 代码输出什么？',
      'printf("%d", '+a+' '+op+' '+b+');',
      String(r),[String(a+b),String(a*b),String(r+1)],
      a+' '+op+' '+b+' = '+r+'（按二进制逐位运算：'+a.toString(2)+' '+op+' '+b.toString(2)+' = '+r.toString(2)+'₂）');
  }},
  {k:'保留小数位数',lang:'c',ranks:[1],kb:81,gen:function(){
    var a=riN(1,9),b=riN(1,9),f=parseFloat('3.'+a+b),r1=f.toFixed(1);
    /* 第三个干扰项由答案派生，避开硬编码 "4.0" 撞答案（f≥3.95 时答案四舍五入就是 4.0） */
    return mkCodeQ('这段 C 代码输出什么？',
      'printf("%.1f", '+f.toFixed(2)+');',
      r1,[f.toFixed(0),f.toFixed(2),(parseFloat(r1)+0.5).toFixed(1)],
      '%.1f 表示保留 1 位小数并四舍五入：'+f.toFixed(2)+' → '+r1);
  }},
  /* ---- rank 1 · 选择结构 ---- */
  {k:'if-else 判断',lang:'c',ranks:[1],kb:9,gen:function(){
    var x=riN(1,9),hit=x>3;
    return mkCodeQ('这段 C 代码输出什么？',
      'int x = '+x+';\nif (x > 3)\n{\n    printf("A");\n}\nelse\n{\n    printf("B");\n}',
      hit?'A':'B',[hit?'B':'A','C','3'],
      'x='+x+'，条件 x>3 是'+(hit?'真':'假')+'，'+(hit?'走 if 输出 A':'走 else 输出 B'));
  }},
  {k:'if-else 链',lang:'c',ranks:[1],kb:9,gen:function(){
    var x=riN(1,9),r=x>=7?'大':(x>=4?'中':'小');
    return mkCodeQ('这段 C 代码输出什么？',
      'int x = '+x+';\nif (x >= 7)\n{\n    printf("大");\n}\nelse if (x >= 4)\n{\n    printf("中");\n}\nelse\n{\n    printf("小");\n}',
      r,[r==='大'?'中':'大',r==='小'?'中':'小','零'],
      '从上往下找第一个成立的条件：x='+x+'，'+(r==='大'?'x>=7 成立':(r==='中'?'x>=7 不成立，x>=4 成立':'x>=7 与 x>=4 都不成立'))+'，输出「'+r+'」');
  }},
  {k:'逻辑与或非',lang:'c',ranks:[1],kb:12,gen:function(){
    var a=riN(2,4),b=riN(6,9),hit=(a>1&&b<5);
    return mkCodeQ('这段 C 代码输出什么？',
      'int a = '+a+', b = '+b+';\nif (a > 1 && b < 5)\n{\n    printf("Y");\n}\nelse\n{\n    printf("N");\n}',
      hit?'Y':'N',[hit?'N':'Y','1','0'],
      'a>1 是'+(a>1?'真':'假')+'，b<5 是'+(b<5?'真':'假')+'，&& 要求两边都真：'+(hit?'输出 Y':'输出 N'));
  }},
  {k:'switch 分支',lang:'c',ranks:[1,2],kb:3,gen:function(){
    var x=riN(1,3);
    return mkCodeQ('这段 C 代码输出什么？',
      'int x = '+x+';\nswitch (x)\n{\ncase 1:\n    printf("A");\n    break;\ncase 2:\n    printf("B");\n    break;\ndefault:\n    printf("C");\n}',
      x===1?'A':(x===2?'B':'C'),[x===1?'B':(x===2?'C':'A'),'D','X'],
      'switch 按 x 的值匹配 case：x='+x+'，'+(x===1?'匹配 case 1 输出 A':(x===2?'匹配 case 2 输出 B':'没有匹配项走 default 输出 C')));
  }},
  /* ---- rank 1-2 · 循环结构 ---- */
  {k:'for 循环次数',lang:'c',ranks:[1],kb:6,gen:function(){
    var n=riN(3,8);
    return mkCodeQ('这段 C 代码循环体执行多少次？',
      'for (int i = 0; i < '+n+'; i++) { }',
      String(n),[String(n-1),String(n+1),String(n*2)],
      'i 从 0 到 '+(n-1)+'，共 '+n+' 次（i<n 时执行，i='+n+' 时退出）');
  }},
  {k:'while 累加',lang:'c',ranks:[1],kb:7,gen:function(){
    var n=riN(3,9);
    return mkCodeQ('这段 C 代码输出什么？',
      'int i = 1, s = 0;\nwhile (i <= '+n+')\n{\n    s += i;\n    i++;\n}\nprintf("%d", s);',
      String(n*(n+1)/2),[String(n*n),String(n*(n-1)/2),String(n+1)],
      '循环把 1 到 '+n+' 全加起来，等差数列求和 '+(n*(n+1))+'÷2 = '+(n*(n+1)/2));
  }},
  {k:'for 累加',lang:'c',ranks:[1],kb:7,gen:function(){
    var n=riN(3,9);
    return mkCodeQ('这段 C 代码输出什么？',
      'int s = 0;\nfor (int i = 1; i <= '+n+'; i++) s += i;\nprintf("%d", s);',
      String(n*(n+1)/2),[String(n*n),String(n*(n+1)/2+1),String(n)],
      'for 循环把 1 到 '+n+' 累加到 s，等差数列求和 '+(n*(n+1))+'÷2 = '+(n*(n+1)/2));
  }},
  /* ---- rank 2 · 循环结构进阶 ---- */
  {k:'break 中断',lang:'c',ranks:[2],kb:4,gen:function(){
    var k=riN(3,6);
    return mkCodeQ('这段 C 代码输出什么？',
      'for (int i = 0; i < 10; i++)\n{\n    if (i == '+k+')\n    {\n        break;\n    }\n}\nprintf("%d", i);',
      String(k),[String(k+1),String(k-1),String(10)],
      'i 到 '+k+' 时命中 if 触发 break，立即跳出循环，此时 i = '+k);
  }},
  {k:'continue 跳过',lang:'c',ranks:[2],kb:5,gen:function(){
    var n=riN(4,8);
    return mkCodeQ('这段 C 代码输出什么？',
      'int s = 0;\nfor (int i = 1; i <= '+n+'; i++)\n{\n    if (i % 2 == 0)\n    {\n        continue;\n    }\n    s += i;\n}\nprintf("%d", s);',
      String(squareSumOdd(n)),[String(n*(n+1)/2),String(squareSumOdd(n)+1),String(n)],
      'continue 跳过偶数，只加奇数：1+3+… 到 '+n+' = '+squareSumOdd(n));
  }},
  {k:'do-while 至少一次',lang:'c',ranks:[2],kb:12,gen:function(){
    var a=riN(2,5),b=riN(2,4),r=Math.min(a+1,b);
    return mkCodeQ('这段 C 代码输出什么？',
      'int i = '+a+';\ndo { i++; } while (i < '+b+');\nprintf("%d", i);',
      String(r),[String(a),String(b),String(a+b)],
      'do-while 先执行一次再判断：i 先变成 '+(a+1)+'，再判断是否 <'+b+'，'+(r===(a+1)?'满足则退出':'继续循环到 '+r));
  }},
  {k:'双重循环计数',lang:'c',ranks:[2,3],kb:4,gen:function(){
    var n=riN(3,6);
    return mkCodeQ('这段 C 代码输出什么？',
      'int s = 0;\nfor (int i = 0; i < '+n+'; i++)\n{\n    for (int j = 0; j < '+n+'; j++)\n    {\n        s++;\n    }\n}\nprintf("%d", s);',
      String(n*n),[String(n*2),String(n),String(n*n-1)],
      '外层 '+n+' 次、内层每次 '+n+' 次，s 共加 '+n+'×'+n+' = '+(n*n)+' 次');
  }},
  /* ---- rank 2-3 · 数组（C） ---- */
  {k:'数组下标',lang:'c',ranks:[2],kb:36000,gen:function(){
    var v=[riN(1,9),riN(10,19),riN(20,29),riN(30,39)],i=riN(0,3);
    var others=v.filter(function(x){return x!==v[i];});
    return mkCodeQ('这段 C 代码输出什么？',
      'int a[4] = {'+v.join(', ')+'};\nprintf("%d", a['+i+']);',
      String(v[i]),pickAlts(String(v[i]),others.map(String)),
      '数组下标从 0 开始，a['+i+'] 是第 '+(i+1)+' 个元素 '+v[i]);
  }},
  {k:'数组遍历求和',lang:'c',ranks:[2],kb:27,gen:function(){
    var n=riN(3,5),arr=[],s=0;
    for(var i=0;i<n;i++){var v=riN(1,9);arr.push(v);s+=v;}
    return mkCodeQ('这段 C 代码输出什么？',
      'int a['+n+'] = {'+arr.join(', ')+'};\nint s = 0;\nfor (int i = 0; i < '+n+'; i++) s += a[i];\nprintf("%d", s);',
      String(s),[String(s+1),String(s-1),String(s*n)],
      '循环把数组每个元素加起来：'+arr.join('+')+' = '+s);
  }},
  {k:'sizeof 数组长度',lang:'c',ranks:[2,3],kb:7,gen:function(){
    var n=riN(3,9);
    return mkCodeQ('这段 C 代码输出什么？',
      'int a['+n+'];\nprintf("%d", (int)(sizeof(a) / sizeof(a[0])));',
      String(n),[String(n-1),String(n*4),'1'],
      'sizeof(a) 是整个数组的字节数，除以单个元素的字节数就是元素个数 '+n);
  }},
  /* ---- rank 2-3 · 字符串（C） ---- */
  {k:'字符串下标字符',lang:'c',ranks:[2],kb:9,gen:function(){
    var s=['hello','world','abcde'][riN(0,2)],i=riN(0,2);
    var cands=[];
    for(var j=0;j<s.length;j++){var ch=s.charAt(j);if(ch!==s.charAt(i)&&cands.indexOf(ch)<0)cands.push(ch);}
    while(cands.length<3)cands.push(String.fromCharCode(65+cands.length));
    return mkCodeQ('这段 C 代码输出什么？',
      'char s[] = "'+s+'";\nprintf("%c", s['+i+']);',
      s.charAt(i),pickAlts(s.charAt(i),cands),
      '字符数组下标从 0 开始，s['+i+'] 是第 '+(i+1)+' 个字符 "'+s.charAt(i)+'"');
  }},
  {k:'strlen 字符串长度',lang:'c',ranks:[2],kb:3,gen:function(){
    var s=['abc','hello','program'][riN(0,2)];
    return mkCodeQ('这段 C 代码输出什么？',
      '#include <string.h>\nchar s[] = "'+s+'";\nprintf("%d", (int)strlen(s));',
      String(s.length),[String(s.length+1),String(s.length*2),String(s.length-1)],
      'strlen 统计字符串长度（不含结尾 \\0）："'+s+'" 有 '+s.length+' 个字符');
  }},
  /* ---- rank 3-4 · 函数（C） ---- */
  {k:'函数调用返回值',lang:'c',ranks:[3],kb:8,gen:function(){
    var a=riN(2,9);
    return mkCodeQ('这段 C 代码输出什么？',
      'int f(int x) { return x * 2; }\nprintf("%d", f('+a+'));',
      String(a*2),[String(a),String(a+2),String(a*a)],
      '调用 f('+a+')，形参 x='+a+'，函数体 return x*2，返回 '+(a*2));
  }},
  /* ---- rank 2-3 · 指针基础（C，保留并搬入） ---- */
  {k:'指针下标访问',lang:'c',ranks:[2,3],kb:2,gen:function(){
    var k=riN(1,2);
    return mkCodeQ('这段 C 代码输出什么？',
      'int a[3] = {1, 2, 3};\nint *p = a;\nprintf("%d", *(p + '+k+'));',
      String(k+1),[String(k),String(3),String(k+2)],
      'p 指向 a[0]，p + '+k+' 指向 a['+k+']（下标从 0 算），解引用得 '+(k+1));
  }},
  {k:'指针解引用赋值',lang:'c',ranks:[2,3],kb:70,gen:function(){
    var x=riN(3,9),v=riN(10,19);
    return mkCodeQ('这段 C 代码输出什么？',
      'int x = '+x+';\nint *p = &x;\n*p = '+v+';\nprintf("%d", x);',
      String(v),[String(x),String(x+v),String(v-x)],
      'p 存的是 x 的地址，*p = '+v+' 就是直接改 x 本身，所以输出 '+v);
  }},
  {k:'指针数组语法',lang:'c',ranks:[2,3],kb:1,gen:function(){
    return mkCodeQ('这段 C 代码输出什么？',
      'int a[4] = {1, 2, 3, 4};\nint *p = a + 1;\nprintf("%d", p[1]);',
      '3',['2','4','1'],
      'p 指向 a[1]，p[1] 相当于 a[2]，值是 3');
  }},
  /* ---- rank 3-4 · 递归与算法（C，保留并搬入） ---- */
  {k:'递归阶乘',lang:'c',ranks:[3,4],kb:3,gen:function(){
    var n=riN(4,6);
    return mkCodeQ('这段 C 代码输出什么？',
      'int f(int n) {\n    return n <= 1 ? 1 : n * f(n - 1);\n}\nprintf("%d", f('+n+'));',
      String(fact(n)),[String(fact(n)+n),String(n*n),String(fact(n-1))],
      '这是阶乘递归：'+n+'! = '+factSeq(n)+' = '+fact(n));
  }},
  {k:'递归斐波那契',lang:'c',ranks:[3,4],kb:6,gen:function(){
    var n=riN(6,11);
    return mkCodeQ('这段 C 代码输出什么？',
      'int f(int n) {\n    return n < 2 ? n : f(n - 1) + f(n - 2);\n}\nprintf("%d", f('+n+'));',
      String(fibOf(n)),[String(fibOf(n)+1),String(fibOf(n-1)),String(n)],
      '斐波那契递推 F(n)=F(n−1)+F(n−2)，逐项算到 F('+n+') = '+fibOf(n));
  }},
  {k:'二进制1的个数',lang:'c',ranks:[3,4],kb:16,gen:function(){
    var X=[5,6,7,9,10,11,12,13,14,17,19,21,23,25,27,29],x=X[riN(0,15)];
    var c=0,v=x;while(v){c+=v&1;v>>=1;}
    return mkCodeQ('这段 C 代码输出什么？',
      'int n = '+x+';\nint c = 0;\nwhile (n) {\n    c += n & 1;\n    n >>= 1;\n}\nprintf("%d", c);',
      String(c),[String(c+1),String(c+2),String(c+3)],
      '这段在数二进制里 1 的个数：'+x+' = '+binOf(x)+'₂，共有 '+c+' 个 1');
  }},
  {k:'指针相减',lang:'c',ranks:[3,4],kb:5,gen:function(){
    var k=riN(2,6);
    return mkCodeQ('这段 C 代码输出什么？',
      'int a[8] = {0};\nint *p = &a['+k+'];\nprintf("%d", (int)(p - a));',
      String(k),[String(k+1),String(k-1),String(k*4)],
      '指针相减得到相隔的元素个数，p 指向 a['+k+']，与 a 相差 '+k);
  }},
  /* ---- rank 4 · 陷阱 / 未定义行为（C，保留并搬入） ---- */
  {k:'宏文本替换陷阱',lang:'c',ranks:[4],kb:16,gen:function(){
    var a=riN(1,4),b=riN(1,4);
    return mkCodeQ('这段 C 代码输出什么？',
      '#define SQ(x) x*x\n\nprintf("%d", SQ('+a+' + '+b+'));',
      String(a+b*b),[String((a+b)*(a+b)),String(a*a+b*b),String(a+b*2)],
      '宏只是文本替换，SQ('+a+' + '+b+') 展开成 '+a+' + '+b+' * '+b+'，先乘后加得 '+(a+b*b));
  }},
  {k:'补码转无符号',lang:'c',ranks:[4],kb:9,gen:function(){
    var k=riN(1,9);
    return mkCodeQ('这段 C 代码输出什么（8 位 char）？',
      'char c = -'+k+';\nprintf("%d", (unsigned char)c);',
      String(256-k),[String(-k),String(k),String(256+k)],
      '负数按补码存，转成无符号就是 256 − '+k+' = '+(256-k));
  }},
  {k:'前置后置综合',lang:'c',ranks:[3,4],kb:12,gen:function(){
    var sv=riN(0,2),ops=['i++','++i','i--','--i'],op=ops[riN(0,3)];
    var pre=/^[+-]{2}/.test(op),after=(op==='i++'||op==='++i');
    var a=pre?(after?sv+1:sv-1):sv;
    var iv=after?sv+1:sv-1;
    var why=pre?('前置 '+op+' 先自增/自减再赋值，a 拿到新值 '+a):('后置 '+op+' 先取值 '+sv+' 赋给 a，i 之后才变 '+iv);
    return mkCodeQ('这段 C 代码输出什么？',
      'int i = '+sv+';\nint a = '+op+';\nprintf("%d %d", a, i);',
      a+' '+iv,[(a+1)+' '+iv,a+' '+(iv+1),(a+1)+' '+(iv+1)],why);
  }},
  {k:'无符号溢出回绕',lang:'c',ranks:[4],kb:1296,gen:function(){
    var a=riN(215,250),b=riN(10,45),r=(a+b)%256;
    return mkCodeQ('这段 C 代码输出什么？',
      'unsigned char c = '+a+';\nc += '+b+';\nprintf("%d", c);',
      String(r),pickAlts(r,[String(256-r),String(255-r),String(r>0?r-1:1)]),
      'unsigned char 只存 8 位、上限 255，'+(a+b)+' 溢出后回绕：'+(a+b)+' − 256 = '+r);
  }},
  /* ---- 以下为其他语言（lang 标注，仅当用户勾选对应语言且档位≥2 时出现） ---- */
  {k:'Python 乘法输出',lang:'python',ranks:[2,3,4],kb:25,gen:function(){
    var a=riN(2,6),b=riN(2,6);
    return mkCodeQ('这段 Python 代码输出什么？',
      'a = '+a+'\nb = '+b+'\nprint(a * b)',
      String(a*b),[String(a+b),String(a*10+b),String(a*b+1)],
      'Python 里数字的 * 是乘法，'+a+' × '+b+' = '+(a*b));
  }},
  {k:'Python 字符串下标',lang:'python',ranks:[2,3,4],kb:9,gen:function(){
    var s=['abc','quiz','code'][riN(0,2)],i=riN(0,2);
    return mkCodeQ('这段 Python 代码输出什么？',
      's = "'+s+'"\nprint(s['+i+'])',
      s.charAt(i),[s.charAt((i+1)%3),s.charAt((i+2)%3),String(s.length)],
      '字符串下标从 0 开始，s['+i+'] 是第 '+(i+1)+' 个字符 "'+s.charAt(i)+'"');
  }},
  {k:'Python 切片长度',lang:'python',ranks:[2,3,4],kb:6,gen:function(){
    var n=riN(2,4),k=riN(2,3);
    return mkCodeQ('这段 Python 代码输出什么？',
      'a = [1, 2, 3, 4, 5][:'+n+']\nprint(len(a) * '+k+')',
      String(n*k),[String(n+k),String(n),String(n*k+1)],
      '切片 [:'+n+'] 取前 '+n+' 个元素，len 得 '+n+'，再乘 '+k+' = '+(n*k));
  }},
  {k:'Python 可变参数',lang:'python',ranks:[2,3,4],kb:1,gen:function(){
    return mkCodeQ('这段 Python 代码输出什么？',
      'def f(t):\n    t.append(9)\n\nx = [1]\nf(x)\nprint(len(x))',
      '2',['1','9','0'],
      '列表是可变对象、按引用传入，append 改的是原列表，长度从 1 变 2');
  }},
  {k:'Python 默认参数陷阱',lang:'python',ranks:[3,4],kb:28,gen:function(){
    var t=riN(0,3),m=riN(3,9),body='';
    for(var i=0;i<t;i++)body+='f('+(i+1)+')\n';
    return mkCodeQ('这段 Python 代码输出什么？',
      'def f(x, acc=[]):\n    acc.append(x)\n    return len(acc)\n\n'+body+'print(f('+m+'))',
      String(t+1),[String(t),String(t+2),'1'],
      '默认参数 acc=[] 只在定义时创建一次，前面调用已累积 '+t+' 个，再 append 变 '+(t+1)+' 个');
  }},
  {k:'Java 字符串长度',lang:'java',ranks:[2,3,4],kb:4,gen:function(){
    var s=['quiz','code','java','html'][riN(0,3)];
    return mkCodeQ('这段 Java 代码输出什么？',
      'String s = "'+s+'";\nSystem.out.println(s.length());',
      String(s.length),[String(s.length-1),String(s.length+1),String(s.length*2)],
      'Java 的 length() 返回字符个数，"'+s+'" 有 '+s.length+' 个字符');
  }},
  {k:'Java 数组排序',lang:'java',ranks:[3,4],kb:1,gen:function(){
    return mkCodeQ('这段 Java 代码输出什么？',
      'int[] a = {5, 2, 9};\nArrays.sort(a);\nSystem.out.println(a[0]);',
      '2',['5','9','0'],
      'Arrays.sort 升序排成 {2, 5, 9}，a[0] 是最小的 2');
  }},
  {k:'JS 偶数计数',lang:'js',ranks:[2,3,4],kb:4,gen:function(){
    var n=riN(4,7);
    return mkCodeQ('这段 JavaScript 代码输出什么？',
      'var a = [];\nfor (var i = 1; i <= '+n+'; i++) {\n  if (i % 2 === 0) a.push(i);\n}\nconsole.log(a.length);',
      String(Math.floor(n/2)),[String(Math.ceil(n/2)),String(n),String(n-1)],
      '1 到 '+n+' 里偶数有 '+(Math.floor(n/2))+' 个，只有偶数被 push 进数组');
  }},
  {k:'JS 数组排序拼接',lang:'js',ranks:[3,4],kb:1,gen:function(){
    return mkCodeQ('这段 JavaScript 代码输出什么？',
      'var a = [3, 1, 2];\na.sort();\nconsole.log(a.join(""));',
      '123',['321','312','132'],
      '默认 sort 按字符串升序排列，得到 [1, 2, 3]，拼接成 "123"');
  }},
  {k:'JS 字符串拼接',lang:'js',ranks:[2,3,4],kb:3,gen:function(){
    var n=riN(2,4);
    return mkCodeQ('这段 JavaScript 代码输出什么？',
      'var s = "";\nfor (var i = 0; i < '+n+'; i++) {\n  s += i;\n}\nconsole.log(s);',
      '012345'.slice(0,n),['123456'.slice(0,n),String(n),'9'.slice(0,n)],
      'i 取 0 到 '+(n-1)+'，字符串依次拼接，得 "'+      '012345'.slice(0,n)+'"');
  }},
  /* ---- 代码补全题（kind:'fill'）：读代码 + 填空，补全关键符号 / 关键字 / 表达式 ---- */
  {k:'C 补全·比较运算符',lang:'c',ranks:[0],kb:1,gen:function(){
    return mkCodeFill('补全下面 C 代码的空白处，使它表示“a 大于 b 时输出 a 大”。',
      'int a = 7, b = 3;\nif (a ___ b)\n{\n    printf("a 大");\n} /* 判断 a 是否大于 b */',
      '>','',
      '> 是大于比较运算符，a > b 为真时进入 if 分支。');
  }},
  {k:'C 补全·变量赋值',lang:'c',ranks:[0],kb:1,gen:function(){
    return mkCodeFill('补全下面 C 代码的空白处，使 x 的值等于 5。',
      'int x = ___; /* x 应为 5 */',
      '5','',
      '直接写 5 即可：int x = 5;');
  }},
  {k:'JS 补全·数组反转',lang:'js',ranks:[0,1],kb:1,gen:function(){
    return mkCodeFill('补全下面 JavaScript 代码的空白处，使 r 成为 a 的反转数组。',
      'var a = [1, 2, 3];\nvar r = a.______(); // 反转数组',
      'reverse','',
      '数组方法 reverse() 会原地反转并返回该数组。');
  }},
  {k:'C 补全·累加赋值',lang:'c',ranks:[1],kb:1,gen:function(){
    return mkCodeFill('补全下面 C 代码的空白处，使 sum 成为 1 到 5 的累加和。',
      'int sum = 0;\nfor (int i = 1; i <= 5; i++)\n{\n    sum = sum ___ i;\n} /* 累加 1..5 */',
      '+=','',
      '+= 是复合赋值，sum += i 等价于 sum = sum + i。');
  }},
  {k:'C 补全·循环条件',lang:'c',ranks:[1],kb:1,gen:function(){
    return mkCodeFill('补全下面 C 代码的空白处，使循环打印 0 到 9。',
      'for (int i = 0; i ___ 10; i++)\n{\n    printf("%d ", i);\n} /* 打印 0..9 */',
      '<','',
      'i < 10 时循环继续，打印 0,1,...,9 共 10 个数。');
  }},
  {k:'JS 补全·函数返回',lang:'js',ranks:[1,2],kb:1,gen:function(){
    return mkCodeFill('补全下面 JavaScript 代码的空白处，使 add 返回两数之和。',
      'function add(a, b) {\n  return a ___ b;\n}',
      '+','',
      '+ 把两个参数相加后返回。');
  }},
  {k:'C 补全·数组下标',lang:'c',ranks:[2],kb:1,gen:function(){
    return mkCodeFill('补全下面 C 代码的空白处，使循环正序打印数组每个元素。',
      'int arr[] = {3, 1, 4};\nfor (int i = 0; i < 3; i++)\n{\n    printf("%d ", arr[___]);\n}',
      'i','',
      '用下标 i 访问元素 arr[i]，i 从 0 到 2 正序遍历。');
  }},
  {k:'JS 补全·字符串长度',lang:'js',ranks:[2,3],kb:1,gen:function(){
    return mkCodeFill('补全下面 JavaScript 代码的空白处，使 n 等于字符串 s 的长度。',
      'var s = "hello";\nvar n = s.______; // 字符串长度',
      'length','',
      '字符串的 length 属性给出字符个数。');
  }},
  {k:'C 补全·取地址',lang:'c',ranks:[3],kb:1,gen:function(){
    return mkCodeFill('补全下面 C 代码的空白处，使指针 p 指向变量 x。',
      'int x = 10;\nint *p = ___; /* p 指向 x */',
      '&x','',
      '& 是取地址符，&x 得到 x 的地址赋给指针 p。');
  }},
  {k:'JS 补全·对象属性',lang:'js',ranks:[3,4],kb:1,gen:function(){
    return mkCodeFill('补全下面 JavaScript 代码的空白处，使 v 等于对象 o 的 name 属性值。',
      'var o = { name: "Tom" };\nvar v = o.______; // 取出 name 的值',
      'name','',
      '用点号 o.name 访问对象属性。');
  }},
  {k:'C 补全·阶乘递归',lang:'c',ranks:[4],kb:1,gen:function(){
    return mkCodeFill('补全下面 C 代码的空白处，使 fact 正确计算 n 的阶乘。',
      'int fact(int n)\n{\n    if (n <= 1)\n    {\n        return 1;\n    }\n    return n ___ fact(n - 1);\n} /* 阶乘 */',
      '*','',
      'n! = n × (n-1)!，所以返回 n * fact(n-1)。');
  }}
];

/* 矩阵辅助函数（定义于 CODE_TOPICS 之后） */
function bitsFlip(b){var s=(b==='0'?'1':'0');return b.slice(1)+s;}
function bitsFlip2(b){var s=b.charAt(0)==='1'?'0':'1';return s+b.slice(1);}
function randBits(len){var s='';for(var i=0;i<len;i++)s+=(Math.random()<0.5?'0':'1');return s;}
function squareSumOdd(n){var s=0;for(var i=1;i<=n;i++)if(i%2) s+=i;return s;}
function pickAlts(ans,cands){
  var seen={},out=[],a=String(ans);
  seen[a]=1;
  (cands||[]).forEach(function(c){c=String(c);if(!seen[c]&&out.length<3){seen[c]=1;out.push(c);}});
  var pad=0;
  while(out.length<3){var p='#'+pad;if(!seen[p]){seen[p]=1;out.push(p);}pad++;}
  return out;
}

/* 程序编写板块组题：按已掌握语言过滤，档位不够时相邻档补齐，绝不空题 */
QA_TYPES.code.genSection=function(n,diff,sec){
  n=Math.max(1,n|0);
  var dd=(typeof diff==='number'&&diff>=0&&diff<5)?diff:0;
  /* 板块由调用方传进来（vm 直跑引擎时没有 qaSection 这个全局） */
  var _sec=(typeof sec==='string')?sec:'';
  if(!_sec&&typeof qaSection==='string')_sec=qaSection;
  var allowed=codeAllowedLangs();
  /* useLang=true 按已掌握语言过滤；false 忽略语言（选择题补池用） */
  function poolWith(useLang){
    function poolFor(d){
      return CODE_TOPICS.filter(function(t){
        return t.ranks.indexOf(d)>=0 && (!useLang||!allowed||allowed.indexOf(t.lang)>=0);
      });
    }
    var p=poolFor(dd);
    if(p.length<2){
      var alt=[dd-1,dd+1,dd-2,dd+2];
      for(var i=0;i<alt.length;i++){
        if(alt[i]<0||alt[i]>4)continue;
        p=p.concat(poolFor(alt[i]));
        if(p.length>=4)break;
      }
    }
    return p;
  }
  var out=[],seen={};
  function qk(q){return q.q+'\u0001'+(q.code||'');}
  /* C3：选择题板块只收自带选项的题 —— mkCodeFill 生成的是填空题（opts=null），
     放进「选择题」会退化成输入框，与板块承诺不符 */
  function pickable(q){
    if(!q||!q.q||q.a==null)return false;
    if(_sec==='choice'&&!(q.opts&&q.opts.length>=2))return false;
    return true;
  }
  function fill(pool,cap){
    var guard=0;
    while(out.length<n&&pool.length&&guard++<cap){
      var t=pool[riN(0,pool.length-1)],q=null;
      try{q=t.gen();}catch(e){continue;}
      if(!pickable(q)||seen[qk(q)])continue;
      q.tag=q.tag||t.lang||t.k;
      seen[qk(q)]=1;out.push(q);
    }
  }
  fill(poolWith(true),1500);
  /* 旧随机池兜底只留给非选择题板块：POOLS.code 的硬凑干扰项不再进选择题 */
  if(out.length<n&&_sec!=='choice'){
    var more=QA_TYPES.code.gen(n-out.length,dd);
    more.forEach(function(q){
      if(out.length>=n||!q||seen[qk(q)])return;
      seen[qk(q)]=1;out.push(q);
    });
  }
  return out.slice(0,n);
};
/* ===== 手写代码题（AI 评判用，题面与样例都在本地生成） ===== */
var CODE_TASKS=[
  {r:0,lang:'js',t:'用 JavaScript 写一个函数 sum(a, b)，返回两个数之和。',ex:'sum(2, 3) → 5',tip:'直接返回 a + b',
   sol:'function sum(a, b) { return a + b; }',
   steps:['函数需要把两个参数加起来','直接 return a + b 即可']},
  {r:0,lang:'js',t:'用 JavaScript 写一个函数 maxOf(a, b)，返回较大的那个数。',ex:'maxOf(4, 9) → 9',tip:'比较两个数',
   sol:'function maxOf(a, b) { return a > b ? a : b; }',
   steps:['比较 a 和 b 的大小','哪个大返回哪个：a > b 则返回 a，否则返回 b']},
  {r:0,lang:'js',t:'用 JavaScript 写一个函数 minOf(a, b)，返回较小的那个数。',ex:'minOf(4, 9) → 4',tip:'比较两个数、保留较小的那个',
   sol:'function minOf(a, b) { return a < b ? a : b; }',
   steps:['比较 a 和 b 的大小','哪个小返回哪个：a < b 则返回 a，否则返回 b']},
  {r:0,lang:'js',t:'用 JavaScript 写一个函数 absVal(n)，返回 n 的绝对值。',ex:'absVal(-7) → 7',tip:'负数取相反数、非负原样返回',
   sol:'function absVal(n) { return n < 0 ? -n : n; }',
   steps:['绝对值：负数取相反数，非负数不变','判断 n < 0 时返回 -n，否则返回 n']},
  {r:0,lang:'js',t:'用 JavaScript 写一个函数 isPositive(n)，n 为正数返回 true，否则返回 false。',ex:'isPositive(-3) → false',tip:'与 0 比较',
   sol:'function isPositive(n) { return n > 0; }',
   steps:['正数就是大于 0','直接返回 n > 0 的结果']},
  {r:1,lang:'js',t:'用 JavaScript 写一个函数 isEven(n)，n 是偶数返回 true，否则返回 false。',ex:'isEven(7) → false',tip:'用取余判断',
   sol:'function isEven(n) { return n % 2 === 0; }',
   steps:['偶数能被 2 整除','n % 2 === 0 就是偶数，直接返回']},
  {r:1,lang:'js',t:'用 JavaScript 写一个函数 reverseStr(s)，返回反转后的字符串。',ex:'reverseStr("abc") → "cba"',tip:'循环或内置反转',
   sol:'function reverseStr(s) { return s.split("").reverse().join(""); }',
   steps:['字符串不能直接反转','先 split("") 拆成字符数组','reverse() 反转','join("") 拼回字符串']},
  {r:1,lang:'js',t:'用 JavaScript 写一个函数 repeatStr(s, n)，返回把 s 重复 n 次的字符串。',ex:'repeatStr("ab", 3) → "ababab"',tip:'循环拼接或字符串乘法',
   sol:'function repeatStr(s, n) { var r = ""; for (var i = 0; i < n; i++) r += s; return r; }',
   steps:['准备一个空字符串','循环 n 次，每次都把 s 拼进去','返回拼接结果']},
  {r:1,lang:'js',t:'用 JavaScript 写一个函数 countVowels(s)，统计元音字母 a/e/i/o/u 的个数。',ex:'countVowels("hello") → 2',tip:'遍历每个字符逐个判断',
   sol:'function countVowels(s) { var n = 0; for (var i = 0; i < s.length; i++) { if ("aeiou".indexOf(s[i].toLowerCase()) >= 0) n++; } return n; }',
   steps:['准备计数器 n=0','遍历每个字符（先转小写）','是 a/e/i/o/u 之一就 n++','返回 n']},
  {r:1,lang:'js',t:'用 JavaScript 写一个函数 factorial(n)，返回 n 的阶乘（0 的阶乘是 1）。',ex:'factorial(5) → 120',tip:'递推 n × (n−1)!，边界 0! = 1',
   sol:'function factorial(n) { if (n <= 1) return 1; return n * factorial(n - 1); }',
   steps:['阶乘：n! = n × (n-1)!','边界：0! = 1，1! = 1','n <= 1 返回 1','否则递归 n * factorial(n-1)']},
  {r:2,lang:'js',t:'用 JavaScript 写一个函数 countChar(s, c)，统计字符 c 在 s 中出现的次数。',ex:'countChar("banana", "a") → 3',tip:'遍历计数',
   sol:'function countChar(s, c) { var n = 0; for (var i = 0; i < s.length; i++) { if (s[i] === c) n++; } return n; }',
   steps:['准备计数器 n=0','遍历 s 的每个字符','与 c 相等就 n++','返回 n']},
  {r:2,lang:'js',t:'用 JavaScript 写一个函数 fib(n)，返回斐波那契数列第 n 项（1, 1, 2, 3, 5 …）。',ex:'fib(6) → 8',tip:'递推或递归',
   sol:'function fib(n) { var a = 1, b = 1; for (var i = 3; i <= n; i++) { var t = a + b; a = b; b = t; } return b; }',
   steps:['斐波那契：每一项 = 前两项之和','第 1、2 项都是 1','从第 3 项起循环递推 a+b','循环到第 n 项返回']},
  {r:2,lang:'js',t:'用 JavaScript 写一个函数 isPrime(n)，n 是素数返回 true，否则返回 false。',ex:'isPrime(7) → true',tip:'从 2 试除到 √n，小于 2 直接 false',
   sol:'function isPrime(n) { if (n < 2) return false; for (var i = 2; i * i <= n; i++) { if (n % i === 0) return false; } return true; }',
   steps:['小于 2 不是素数','从 2 试除到 √n（i*i <= n）','能整除就不是素数','都除不尽就是素数']},
  {r:2,lang:'js',t:'用 JavaScript 写一个函数 reverseArr(a)，返回反转后的数组。',ex:'reverseArr([1,2,3]) → [3,2,1]',tip:'首尾交换或倒序复制',
   sol:'function reverseArr(a) { return a.slice().reverse(); }',
   steps:['注意别改原数组','先 slice() 复制一份','reverse() 反转后返回']},
  {r:2,lang:'js',t:'用 JavaScript 写一个函数 gcd(a, b)，返回 a 与 b 的最大公约数。',ex:'gcd(12, 18) → 6',tip:'辗转相除法：gcd(a,b)=gcd(b,a%b)',
   sol:'function gcd(a, b) { while (b) { var t = a % b; a = b; b = t; } return a; }',
   steps:['辗转相除法：gcd(a,b)=gcd(b, a%b)','循环到 b 为 0','每轮：t=a%b，a=b，b=t','b 为 0 时 a 就是答案']},
  {r:3,lang:'js',t:'用 JavaScript 写一个函数 twoSum(nums, target)，返回和为 target 的两个元素下标（数组返回）。',ex:'twoSum([2, 7, 11, 15], 9) → [0, 1]',tip:'哈希表可做到 O(n)',
   sol:'function twoSum(nums, target) { var m = {}; for (var i = 0; i < nums.length; i++) { var d = target - nums[i]; if (m[d] != null) return [m[d], i]; m[nums[i]] = i; } return []; }',
   steps:['遍历时记录每个数的下标','对当前数求补数 d = target - nums[i]','补数在记录里就返回两个下标','不在就把当前数记进去']},
  {r:3,lang:'js',t:'用 JavaScript 写一个函数 isPalindrome(s)，忽略大小写与非字母数字字符，判断是否回文。',ex:'isPalindrome("A man, a plan") → false',tip:'双指针或反转后比较',
   sol:'function isPalindrome(s) { s = s.toLowerCase().replace(/[^a-z0-9]/g, ""); for (var i = 0, j = s.length - 1; i < j; i++, j--) { if (s[i] !== s[j]) return false; } return true; }',
   steps:['先清洗：转小写、去掉非字母数字','用双指针 i 从前往后、j 从后往前','对应字符不等就不是回文','走完都是相等的就是回文']},
  {r:3,lang:'js',t:'用 JavaScript 写一个函数 firstUnique(s)，返回第一个只出现一次的字符，没有则返回 null。',ex:'firstUnique("aabcc") → "b"',tip:'先计数，再按原顺序找第一个计数为 1 的',
   sol:'function firstUnique(s) { var c = {}; for (var i = 0; i < s.length; i++) c[s[i]] = (c[s[i]] || 0) + 1; for (var i = 0; i < s.length; i++) { if (c[s[i]] === 1) return s[i]; } return null; }',
   steps:['第一遍遍历统计每个字符出现次数','第二遍按原顺序找','第一个计数为 1 的字符就是答案','没有就返回 null']},
  {r:3,lang:'js',t:'用 JavaScript 写一个函数 mySqrt(n)，返回 n 的整数平方根（向下取整）。',ex:'mySqrt(8) → 2',tip:'二分或从 0 递增到 i*i>n',
   sol:'function mySqrt(n) { var x = 0; while ((x + 1) * (x + 1) <= n) x++; return x; }',
   steps:['从 0 开始递增','下一个数的平方还 <= n 就继续','第一个平方超过 n 的数减 1','或直接用二分更高效']},
  {r:3,lang:'js',t:'用 JavaScript 写一个函数 longestWord(s)，返回句子中最长的单词（长度相同取靠前的）。',ex:'longestWord("I love coding") → "coding"',tip:'按空格拆分后逐个比长度',
   sol:'function longestWord(s) { var w = ""; s.split(" ").forEach(function(t) { if (t.length > w.length) w = t; }); return w; }',
   steps:['按空格拆分成单词数组','逐个比较长度','只更新比当前更长的（长度相同不动）','返回最长单词']},
  {r:4,lang:'js',t:'用 JavaScript 写一个函数 flatten(arr)，把任意层嵌套数组展平成一维数组。',ex:'flatten([1, [2, [3]]]) → [1, 2, 3]',tip:'递归处理嵌套',
   sol:'function flatten(arr) { var out = []; arr.forEach(function(x) { if (Array.isArray(x)) out = out.concat(flatten(x)); else out.push(x); }); return out; }',
   steps:['遍历每个元素','是数组就递归展平后拼接','不是数组直接放进结果','递归出口：元素不是数组']},
  {r:4,lang:'js',t:'用 JavaScript 写一个函数 maxSubArray(nums)，返回连续子数组的最大和。',ex:'maxSubArray([-2, 1, -3, 4, -1, 2, 1]) → 6',tip:'Kadane 算法：当前和转负就重新起头',
   sol:'function maxSubArray(nums) { var best = nums[0], cur = 0; for (var i = 0; i < nums.length; i++) { cur = Math.max(nums[i], cur + nums[i]); best = Math.max(best, cur); } return best; }',
   steps:['Kadane 算法：边遍历边累加','当前和加这个数反而变小就重新从它开始','每步更新历史最大和','遍历完的最大和就是答案']},
  {r:4,lang:'js',t:'用 JavaScript 写一个函数 mergeSorted(a, b)，合并两个已升序排列的数组，结果仍升序。',ex:'mergeSorted([1,3,5],[2,4]) → [1,2,3,4,5]',tip:'双指针归并，比到一方走完再补齐',
   sol:'function mergeSorted(a, b) { var out = [], i = 0, j = 0; while (i < a.length && j < b.length) { if (a[i] < b[j]) out.push(a[i++]); else out.push(b[j++]); } while (i < a.length) out.push(a[i++]); while (j < b.length) out.push(b[j++]); return out; }',
   steps:['双指针 i、j 分别指向两个数组','谁小谁先放进结果并前进','一方走完后把另一方剩余全部拼上','结果自然有序']},
  {r:4,lang:'js',t:'用 JavaScript 写一个函数 evalRPN(tokens)，计算逆波兰表达式（数组里是数字字符串与 + - * / 运算符）。',ex:'evalRPN(["2","1","+","3","*"]) → 9',tip:'栈：遇数入栈、遇运算符弹出两个数',
   sol:'function evalRPN(tokens) { var st = []; tokens.forEach(function(t) { if (t === "+" || t === "-" || t === "*" || t === "/") { var b = +st.pop(), a = +st.pop(); st.push(t === "+" ? a + b : t === "-" ? a - b : t === "*" ? a * b : Math.trunc(a / b)); } else { st.push(t); } }); return st[0]; }',
   steps:['准备一个栈','遇到数字就入栈','遇到运算符弹出栈顶两个数（注意顺序：a 是先入的）','算出结果再入栈，最后栈顶就是答案']},
  {r:4,lang:'js',t:'用 JavaScript 写一个函数 hasDupe(a)，数组里有重复元素返回 true，否则返回 false。',ex:'hasDupe([1,2,1]) → true',tip:'哈希集合或双重循环',
   sol:'function hasDupe(a) { var s = {}; for (var i = 0; i < a.length; i++) { if (s[a[i]]) return true; s[a[i]] = 1; } return false; }',
   steps:['用哈希记录见过的元素','遍历时先查是否已存在','存在就是重复，返回 true','没有重复返回 false']},
/* ---- rank 0 · 顺序结构 / 输入输出 ---- */
{r:0,lang:'c',c:1,t:'用 C 语言写一行代码，用 printf 输出数字 5。',ex:'输出：5',tip:'printf + %d',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    printf("%d", 5);\n    return 0;\n}',
 steps:['printf 的 %d 占位符对应一个整数','把 5 填进去：printf("%d", 5);','写完语句别忘了结尾分号']},
{r:0,lang:'c',c:1,t:'用 C 语言声明 int 变量 x 并赋值为 3，然后输出它。',ex:'x 的值是 3',tip:'类型 变量名 = 值;',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int x = 3;\n    printf("%d", x);\n    return 0;\n}',
 steps:['先写类型 int','再写变量名 x，用 = 赋初值 3，结尾分号','printf("%d", x) 输出这个变量']},
{r:0,lang:'c',c:1,t:'用 C 语言让 int 变量 a（初值 1）自增 1，并输出结果。',ex:'a 的值 +1 → 输出 2',tip:'a++ 或 a += 1',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int a = 1;\n    a++;\n    printf("%d", a);\n    return 0;\n}',
 steps:['自增就是 a = a + 1','简写 a++ 或 a += 1 都行','自增后再 printf 才是新值']},
{r:0,lang:'c',c:1,t:'用 C 语言写一段代码：x 大于 0 时输出「正数」。',ex:'x=1 时输出 正数',tip:'if (x > 0)',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int x = 1;\n    if (x > 0)\n    {\n        printf("正数");\n    }\n    return 0;\n}',
 steps:['if 条件判断 x > 0','成立就执行花括号里的 printf','按 C 规范左花括号另起一行']},
{r:0,lang:'c',c:1,t:'用 C 语言写一段代码：x 是偶数输出「偶」，否则输出「奇」。',ex:'x=4 输出 偶，x=3 输出 奇',tip:'x % 2 == 0 判断奇偶',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int x = 4;\n    if (x % 2 == 0)\n    {\n        printf("偶");\n    }\n    else\n    {\n        printf("奇");\n    }\n    return 0;\n}',
 steps:['x % 2 == 0 是偶数，否则是奇数','if 处理偶数，else 处理奇数','两个分支都要有花括号']},

/* ---- rank 1 · 循环结构 / 多分支 ---- */
{r:1,lang:'c',c:1,t:'用 C 语言写一段代码：用 for 循环打印 1 到 5（数字连在一起）。',ex:'输出 12345',tip:'for (i = 1; i <= 5; i++)',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int i;\n    for (i = 1; i <= 5; i++)\n    {\n        printf("%d", i);\n    }\n    return 0;\n}',
 steps:['for 三部分：初值 i=1、条件 i<=5、步进 i++','循环体 printf 打印 i','C89 风格把 int i 声明在 for 外面']},
{r:1,lang:'c',c:1,t:'用 C 语言写一段代码：用 while 循环把 1 加到 n，结果存 sum（n 已声明）。',ex:'n=3 时 sum=6',tip:'while (i <= n)',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int n = 3;\n    int i = 1;\n    int sum = 0;\n    while (i <= n)\n    {\n        sum += i;\n        i++;\n    }\n    printf("%d", sum);\n    return 0;\n}',
 steps:['计数器 i 从 1 开始，sum 从 0 开始','sum 累加 i 后 i 自增','i > n 时循环结束']},
{r:1,lang:'c',c:1,t:'用 C 语言写一段代码：x 在 60 到 100 之间（含）输出「及格」。',ex:'x=70 输出 及格',tip:'x >= 60 && x <= 100',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int x = 70;\n    if (x >= 60 && x <= 100)\n    {\n        printf("及格");\n    }\n    return 0;\n}',
 steps:['两个条件都要满足，用 && 连接','写成 x >= 60 && x <= 100','&& 两侧各留一个空格']},
{r:1,lang:'c',c:1,t:'用 C 语言写一段代码：用 do-while 循环打印 1 到 3。',ex:'输出 123',tip:'do { … } while (i <= 3);',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int i = 1;\n    do\n    {\n        printf("%d", i);\n        i++;\n    } while (i <= 3);\n    return 0;\n}',
 steps:['do-while 先执行一次再判断条件','循环体后要写 while (条件); 结尾带分号','i 每次自增，到 4 时退出']},
{r:1,lang:'c',c:1,t:'用 C 语言写一段代码：level 为 1/2/3 时分别输出「一等奖」「二等奖」「三等奖」，其它输出「未获奖」。',ex:'level=2 输出 二等奖',tip:'switch + case + break',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int level = 2;\n    switch (level)\n    {\n    case 1:\n        printf("一等奖");\n        break;\n    case 2:\n        printf("二等奖");\n        break;\n    case 3:\n        printf("三等奖");\n        break;\n    default:\n        printf("未获奖");\n    }\n    return 0;\n}',
 steps:['switch 按 level 的值跳到对应 case','每个 case 结束要 break，否则会继续往下执行','其它情况用 default']},

/* ---- rank 2 · 数组与字符串 ---- */
{r:2,lang:'c',c:1,t:'用 C 语言写一段代码：求 int 数组 a[5] 所有元素之和。',ex:'a={1,2,3,4,5} → 15',tip:'for 遍历 + 累加',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int a[5] = {1, 2, 3, 4, 5};\n    int i;\n    int sum = 0;\n    for (i = 0; i < 5; i++)\n    {\n        sum += a[i];\n    }\n    printf("%d", sum);\n    return 0;\n}',
 steps:['sum 初值 0','下标从 0 到 4 遍历，累加 a[i]','循环结束后输出 sum']},
{r:2,lang:'c',c:1,t:'用 C 语言写一段代码：统计 int 数组 a[5] 中大于 0 的元素个数。',ex:'a={-1,3,0,7,-2} → 2',tip:'if (a[i] > 0) count++',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int a[5] = {-1, 3, 0, 7, -2};\n    int i;\n    int count = 0;\n    for (i = 0; i < 5; i++)\n    {\n        if (a[i] > 0)\n        {\n            count++;\n        }\n    }\n    printf("%d", count);\n    return 0;\n}',
 steps:['count 初值 0','遍历数组，大于 0 才 count++','注意 0 不算正数']},
{r:2,lang:'c',c:1,t:'用 C 语言写一段代码：求 int 数组 a[5] 的最大值（不调用库函数）。',ex:'a={3,9,2,7,5} → 9',tip:'max 先取 a[0]，再逐个比较',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int a[5] = {3, 9, 2, 7, 5};\n    int i;\n    int max = a[0];\n    for (i = 1; i < 5; i++)\n    {\n        if (a[i] > max)\n        {\n            max = a[i];\n        }\n    }\n    printf("%d", max);\n    return 0;\n}',
 steps:['max 先设为第一个元素','从第二个元素开始比较','更大就更新 max']},
{r:2,lang:'c',c:1,t:'用 C 语言写一段代码：把字符串 s 逆序输出（不修改原串）。',ex:'s="abc" → cba',tip:'strlen + 从末尾倒着打印',
 sol:'#include <stdio.h>\n#include <string.h>\n\nint main(void)\n{\n    char s[] = "abc";\n    int i;\n    for (i = (int)strlen(s) - 1; i >= 0; i--)\n    {\n        printf("%c", s[i]);\n    }\n    return 0;\n}',
 steps:['strlen(s) 得到长度','下标从 len-1 递减到 0','%c 打印单个字符']},
{r:2,lang:'c',c:1,t:'用 C 语言写一段代码：判断字符串 s 是否为回文（如 level）。',ex:'s="level" → 是回文',tip:'双下标向中间夹',
 sol:'#include <stdio.h>\n#include <string.h>\n\nint main(void)\n{\n    char s[] = "level";\n    int i = 0;\n    int j = (int)strlen(s) - 1;\n    int ok = 1;\n    while (i < j)\n    {\n        if (s[i] != s[j])\n        {\n            ok = 0;\n            break;\n        }\n        i++;\n        j--;\n    }\n    printf("%s", ok ? "是回文" : "不是回文");\n    return 0;\n}',
 steps:['左下标 i 从 0、右下标 j 从末尾','对应字符不等就标记失败并 break','全部相等才是回文']},

/* ---- rank 3 · 函数与指针 ---- */
{r:3,lang:'c',c:1,t:'用 C 语言写函数 int maxOf(int a, int b)，返回较大的数。',ex:'maxOf(4, 9) → 9',tip:'if 比较后 return',
 sol:'#include <stdio.h>\n\nint maxOf(int a, int b)\n{\n    if (a > b)\n    {\n        return a;\n    }\n    return b;\n}\n\nint main(void)\n{\n    printf("%d", maxOf(4, 9));\n    return 0;\n}',
 steps:['函数名、参数类型、返回类型要写全','a > b 就返回 a','否则返回 b']},
{r:3,lang:'c',c:1,t:'用 C 语言写函数 void swap(int *a, int *b)，交换两个变量的值。',ex:'x=3,y=7 → 交换后 x=7,y=3',tip:'用临时变量 + 指针解引用',
 sol:'#include <stdio.h>\n\nvoid swap(int *a, int *b)\n{\n    int t = *a;\n    *a = *b;\n    *b = t;\n}\n\nint main(void)\n{\n    int x = 3;\n    int y = 7;\n    swap(&x, &y);\n    printf("%d %d", x, y);\n    return 0;\n}',
 steps:['先用临时变量保存 *a','把 *b 赋给 *a，再把临时值赋给 *b','调用时传地址：swap(&x, &y)']},
{r:3,lang:'c',c:1,t:'用 C 语言写函数 int sumArray(const int *a, int n)，返回数组前 n 个元素之和。',ex:'a={1,2,3,4}, n=4 → 10',tip:'指针当数组用 a[i]',
 sol:'#include <stdio.h>\n\nint sumArray(const int *a, int n)\n{\n    int i;\n    int sum = 0;\n    for (i = 0; i < n; i++)\n    {\n        sum += a[i];\n    }\n    return sum;\n}\n\nint main(void)\n{\n    int a[4] = {1, 2, 3, 4};\n    printf("%d", sumArray(a, 4));\n    return 0;\n}',
 steps:['const 表示函数内不改数组内容','用 a[i] 访问第 i 个元素','累加后 return']},
{r:3,lang:'c',c:1,t:'用 C 语言写函数 int countChar(const char *s, char c)，统计字符 c 在 s 中出现的次数。',ex:'countChar("banana", \'a\') → 3',tip:'遍历到 \'\\0\' 结束',
 sol:'#include <stdio.h>\n\nint countChar(const char *s, char c)\n{\n    int i;\n    int count = 0;\n    for (i = 0; s[i] != \'\\0\'; i++)\n    {\n        if (s[i] == c)\n        {\n            count++;\n        }\n    }\n    return count;\n}\n\nint main(void)\n{\n    printf("%d", countChar("banana", \'a\'));\n    return 0;\n}',
 steps:['字符串以 \'\\0\' 结尾，循环条件写 s[i] != \'\\0\'','相等就 count++','返回 count']},
{r:3,lang:'c',c:1,t:'用 C 语言写函数 int isPrime(int n)，n 是素数返回 1，否则返回 0。',ex:'isPrime(13) → 1',tip:'试除到 sqrt(n)',
 sol:'#include <stdio.h>\n\nint isPrime(int n)\n{\n    int i;\n    if (n < 2)\n    {\n        return 0;\n    }\n    for (i = 2; i * i <= n; i++)\n    {\n        if (n % i == 0)\n        {\n            return 0;\n        }\n    }\n    return 1;\n}\n\nint main(void)\n{\n    printf("%d", isPrime(13));\n    return 0;\n}',
 steps:['小于 2 的数都不是素数','i 从 2 试到 i*i <= n','能被整除就返回 0，循环走完返回 1']},

/* ---- rank 4 · 递归 / 结构体 / 指针综合 ---- */
{r:4,lang:'c',c:1,t:'用 C 语言写递归函数 int fact(int n)，返回 n 的阶乘（0! = 1）。',ex:'fact(5) → 120',tip:'n<=1 返回 1，否则 n * fact(n-1)',
 sol:'#include <stdio.h>\n\nint fact(int n)\n{\n    if (n <= 1)\n    {\n        return 1;\n    }\n    return n * fact(n - 1);\n}\n\nint main(void)\n{\n    printf("%d", fact(5));\n    return 0;\n}',
 steps:['递归必须有终止条件：n <= 1 返回 1','否则 n * fact(n-1)','n 会一路减到 1 收口']},
{r:4,lang:'c',c:1,t:'用 C 语言写递归函数 int fib(int n)，返回斐波那契数列第 n 项（1,1,2,3,5…）。',ex:'fib(7) → 13',tip:'n<=2 返回 1',
 sol:'#include <stdio.h>\n\nint fib(int n)\n{\n    if (n <= 2)\n    {\n        return 1;\n    }\n    return fib(n - 1) + fib(n - 2);\n}\n\nint main(void)\n{\n    printf("%d", fib(7));\n    return 0;\n}',
 steps:['前两项都是 1，作为终止条件','后面每一项 = 前两项之和','递归写法简单但重复计算多']},
{r:4,lang:'c',c:1,t:'用 C 语言写函数 int gcd(int a, int b)，求最大公约数。',ex:'gcd(12, 18) → 6',tip:'辗转相除或递归',
 sol:'#include <stdio.h>\n\nint gcd(int a, int b)\n{\n    if (b == 0)\n    {\n        return a;\n    }\n    return gcd(b, a % b);\n}\n\nint main(void)\n{\n    printf("%d", gcd(12, 18));\n    return 0;\n}',
 steps:['辗转相除：gcd(a,b) = gcd(b, a%b)','b 为 0 时 a 就是最大公约数','递归收口在 b==0']},
{r:4,lang:'c',c:1,t:'用 C 语言定义结构体 struct Student（姓名 char name[20]、成绩 int score），输出成绩最高的学生姓名。',ex:'张三85 李四92 王五78 → 李四',tip:'结构体数组 + 记录最大下标',
 sol:'#include <stdio.h>\n\nstruct Student\n{\n    char name[20];\n    int score;\n};\n\nint main(void)\n{\n    struct Student list[3] = {\n        {"张三", 85},\n        {"李四", 92},\n        {"王五", 78}\n    };\n    int i;\n    int best = 0;\n    for (i = 1; i < 3; i++)\n    {\n        if (list[i].score > list[best].score)\n        {\n            best = i;\n        }\n    }\n    printf("%s", list[best].name);\n    return 0;\n}',
 steps:['struct 定义写在 main 之前','结构体数组初始化用嵌套花括号','best 记下标，最后输出 list[best].name']},
{r:4,lang:'c',c:1,t:'用 C 语言写函数 void reverseArray(int *a, int n)，原地反转数组（不新建数组）。',ex:'a={1,2,3,4,5} → 5 4 3 2 1',tip:'首尾对调，走一半就停',
 sol:'#include <stdio.h>\n\nvoid reverseArray(int *a, int n)\n{\n    int i;\n    int t;\n    for (i = 0; i < n / 2; i++)\n    {\n        t = a[i];\n        a[i] = a[n - 1 - i];\n        a[n - 1 - i] = t;\n    }\n}\n\nint main(void)\n{\n    int a[5] = {1, 2, 3, 4, 5};\n    int i;\n    reverseArray(a, 5);\n    for (i = 0; i < 5; i++)\n    {\n        printf("%d", a[i]);\n    }\n    return 0;\n}',
 steps:['交换 a[i] 与 a[n-1-i]','只需走前一半：i < n/2','原地交换，不需要额外数组']}
];
function genHandTask(rank){
  var r=(typeof rank==='number'&&rank>=0)?rank:0;
  var allowed=codeAllowedLangs();
  var pool=CODE_TASKS.filter(function(x){
    if(!allowed)return true;
    var L=x.lang||'all';
    return L==='all'||allowed.indexOf(L)>=0;
  });
  if(!pool.length)return null;                /* 当前语言没有手写题，由调用侧降级 */
  /* P0-2：手写题一局内不重复。先只在同档里挑没出过的；同档用完了向相邻档扩
     （rad 0→5），全库都出过才清空重来 —— 这样一局 10 题手写模式能拿到 10 道不同的题，
     而不是 5 道转两圈。 */
  var pick=null,rad;
  for(rad=0;rad<=5&&!pick;rad++){
    var band=pool.filter(function(x){return Math.abs(x.r-r)<=rad;});
    var freshIn=band.filter(function(x){return _handUsed.indexOf(x.t)<0;});
    if(freshIn.length)pick=freshIn[ri(freshIn.length)];
  }
  if(!pick){_handUsed.length=0;pick=pool[ri(pool.length)];}
  var t=pick;
  _handUsed.push(t.t);
  /* 解析 = 该题的「要点 + 样例」，本地拼、不调 AI：判错时至少能知道该往哪儿想。
     有 AI 的手写题还能再点「AI 解析」拿更细的讲法，没 AI 也不至于一片空白。 */
  return {q:t.t,a:'（AI 评判）',opts:null,hand:true,task:t,tag:'all',
          sol:t.sol,steps:t.steps||[],
          exp:'要点：'+(t.tip||'')+(t.ex?('　样例：'+t.ex):'')};
}
/*=== CODE_ENGINE_END ===*/
