var g = '';
function bar(x) {
	g += x;
	return x;
}
function foo(x) {
	var y = '';
	switch (x) {
		case bar('foo'):
			y += 'x';
			break;
		case bar('bar'):
			y += 'y';
			break;
		case bar('baz'):
			y += 'z';
			break;
	}
	return y;
}
console.log(foo('foo') + foo('bar') + foo('baz') + g);
