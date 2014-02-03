function foo(x, b) {
	return b ? x.f++ : x.f--;
}
var obj = { f: 5 };
console.log(foo(obj, true));
console.log(obj.f);
console.log(foo(obj, false));
console.log(obj.f);
