function foo($1) {
	var y = '';
	switch ($1) {
		case 'foo':
			y += 'x';
			break;
		case 'bar':
			y += 'y';
			break;
		case 'baz':
			y += 'z';
			break;
	}
	return y;
}
console.log(foo('foo') + foo('bar') + foo('baz'));
