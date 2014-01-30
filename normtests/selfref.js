function f(g) {
	return g(5);
}
var x = f(function fib(x) {
	if (x <= 1)
		return 1;
	else
		return fib(x-1) + fib(x-2);
})
console.log(x)
