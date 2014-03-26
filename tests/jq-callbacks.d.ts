
// /*
//     Interface for the JQuery callback
// */
// interface JQueryCallback {
//     // add(...callbacks: any[]): any;
//     // disable(): any;
//     // empty(): any;
//     fire(...arguments: any[]): any;
//     fired(): boolean;
//     // fireWith(context: any, ...args: any[]): any;
//     // has(callback: any): boolean;
//     // lock(): any;
//     // locked(): boolean;
//     // remove(...callbacks: any[]): any;
// }


// interface JQueryStatic {
//     Callbacks(flags?: string): JQueryCallback;
// }

// var jQuery : JQueryStatic;


interface FooObj {
    makeTrue(x:any): void;
    getValue(): boolean;
}

function foo(): FooObj;
