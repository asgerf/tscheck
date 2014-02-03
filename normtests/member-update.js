function foo(x) {
	x.f++;
}
var obj = { f: 5 };
foo(obj);
console.log(obj.f);
