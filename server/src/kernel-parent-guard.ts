/** Preloaded by the kernel's Node process. IPC belongs only to its launching parent. */
if (process.channel) {
  process.once('disconnect', () => {
    // DSH gets its normal shutdown signal, but cannot remain alive if shutdown stalls.
    setTimeout(() => process.kill(process.pid, 'SIGKILL'), 5000).unref();
    process.kill(process.pid, 'SIGTERM');
  });
}
