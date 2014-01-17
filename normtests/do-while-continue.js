var foo = ['foo','bar',null,'baz'];
var x = '';
var i=-1;
do {
	i++;
	if (i < foo.length && !foo[i])
		continue;
	x += foo[i];
} while (i < foo.length-1);
console.log(x);
