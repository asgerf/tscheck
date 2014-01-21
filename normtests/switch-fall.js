function foo(x) {
	var y = '';
	switch (x) {
		case 'foo':
			y += 'x';
			break;
		case 'bar':
			y += 'y';
		case 'baz':
			y += 'z';
			break;
	}
	return y;
}
console.log(foo('foo') + foo('bar') + foo('baz'));
