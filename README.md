About **tscheck**
=================

**tscheck** is a tool for finding bugs in hand-written TypeScript type definitions (`.d.ts` files). It works by comparing the type definitions to the actual JavaScript library implementation.

Installation
------------

 - Install [node.js](http://nodejs.org/) if you don't already have it.
 - `npm install -g tscheck`

Usage
-----

To check `foo.d.ts` against the library `foo.js`, run the command:

    tscheck foo.js foo.d.ts
    
Or simply:
    
    tscheck foo

Run `tscheck -h` for a list of options.

Output
------

tscheck prints a series of warnings, one warning per line, in no particular order.

The warnings have the format `foo.bar.baz: expected X but found Y`. This means the value one would get by evaluating the pseudo-expression `foo.bar.baz` was expected to have type `X`, but tscheck found something of type `Y` instead.

If there is no output, it means tscheck found no bugs in your `.d.ts` file. This does ***not*** guarantee that the type definitions are actually correct, it just means that tscheck could not find anything wrong.

In some cases, tscheck may get confused and report "false warnings", complaining about type definitions that are actually correct. tscheck apologizes for the inconvenience.


Performance
-----------

tscheck can take several minutes to complete. If you are impatient, pass the flag `--no-analysis`, this will perform a much faster check, but it will also find fewer bugs.

If you wish to check a specific part of the API, you can pass the flag `--path foo` to only check paths that contain the string `foo`; this will typically speed things up a lot.

If tscheck seems to get stuck, try passing `--expose-gc` to the node process. This alleviates a problem with the v8 garbage collector.

Note that even for tiny `.d.ts` files, tscheck still has a warm-up time of a few seconds due to parsing TypeScript's `lib.d.ts` file.

Other Usage Notes
-----------------

The JavaScript library must be compiled to a single `.js` file; so try to get the unminified compiled version of the library you are using. If you are testing a plug-in you should concatenate it with the base library (and use the `--path` argument if possible, to only test the plug-in).

Please run `tsc` on your `.d.ts` file before running tscheck. tscheck assumes that your `.d.ts` passes some well-formedness checks performed by the TypeScript compiler, and will react violently otherwise.

tscheck will leave a `.jsnap` file next to your `.js` file. It contains a snapshot created with [jsnap](https://github.com/asgerf/jsnap). Feel free to delete it; tscheck will regenerate it if necessary, although it speeds things up a bit if you leave it there.

Research
--------

Created by [Asger Feldthaus](http://cs.au.dk/~asf) as part of a [research project](http://cs.au.dk/~amoeller/papers/tscheck/paper.pdf) at [CASA](http://cs.au.dk/~amoeller/CASA/), [Aarhus University](http://cs.au.dk).

Programming language enthusiasts: consider looking at [jsnap](http://github.com/asgerf/jsnap) and [tscore](TSCORE.md).