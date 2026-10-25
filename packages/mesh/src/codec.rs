//! A JSON codec for the request-response behaviour with a configurable request size maximum.
//!
//! libp2p's built-in `json::Behaviour` uses a fixed 1 MB request size, which is too small for
//! file transfers (base64 inflates the payload by ~33%). This codec wraps the same JSON
//! serialization with a larger, configurable limit.

use std::io;
use std::marker::PhantomData;

use async_trait::async_trait;
use futures::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use libp2p::request_response::Codec;
use libp2p::swarm::StreamProtocol;
use serde::{de::DeserializeOwned, Serialize};

/// A JSON codec with configurable request and response size maxima.
pub struct JsonCodec<Req, Resp> {
    request_size_maximum: u64,
    response_size_maximum: u64,
    _phantom: PhantomData<(Req, Resp)>,
}

impl<Req, Resp> JsonCodec<Req, Resp> {
    /// Create a codec with the given size maxima (in bytes).
    pub fn new(request_size_maximum: u64, response_size_maximum: u64) -> Self {
        Self {
            request_size_maximum,
            response_size_maximum,
            _phantom: PhantomData,
        }
    }
}

impl<Req, Resp> Default for JsonCodec<Req, Resp> {
    fn default() -> Self {
        // 16 MB request/response: enough for single-request base64 file transfers.
        Self::new(16 * 1024 * 1024, 16 * 1024 * 1024)
    }
}

impl<Req, Resp> Clone for JsonCodec<Req, Resp> {
    fn clone(&self) -> Self {
        Self {
            request_size_maximum: self.request_size_maximum,
            response_size_maximum: self.response_size_maximum,
            _phantom: PhantomData,
        }
    }
}

#[async_trait]
impl<Req, Resp> Codec for JsonCodec<Req, Resp>
where
    Req: Send + Serialize + DeserializeOwned,
    Resp: Send + Serialize + DeserializeOwned,
{
    type Protocol = StreamProtocol;
    type Request = Req;
    type Response = Resp;

    async fn read_request<T>(&mut self, _: &Self::Protocol, io: &mut T) -> io::Result<Req>
    where
        T: AsyncRead + Unpin + Send,
    {
        let mut vec = Vec::new();
        io.take(self.request_size_maximum).read_to_end(&mut vec).await?;
        Ok(serde_json::from_slice(vec.as_slice())?)
    }

    async fn read_response<T>(&mut self, _: &Self::Protocol, io: &mut T) -> io::Result<Resp>
    where
        T: AsyncRead + Unpin + Send,
    {
        let mut vec = Vec::new();
        io.take(self.response_size_maximum).read_to_end(&mut vec).await?;
        Ok(serde_json::from_slice(vec.as_slice())?)
    }

    async fn write_request<T>(
        &mut self,
        _: &Self::Protocol,
        io: &mut T,
        req: Self::Request,
    ) -> io::Result<()>
    where
        T: AsyncWrite + Unpin + Send,
    {
        let data = serde_json::to_vec(&req)?;
        io.write_all(data.as_ref()).await?;
        Ok(())
    }

    async fn write_response<T>(
        &mut self,
        _: &Self::Protocol,
        io: &mut T,
        resp: Self::Response,
    ) -> io::Result<()>
    where
        T: AsyncWrite + Unpin + Send,
    {
        let data = serde_json::to_vec(&resp)?;
        io.write_all(data.as_ref()).await?;
        Ok(())
    }
}